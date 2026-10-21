using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using P = JE.Tests.IntegrationEditionPressTests;
using M = JE.Tests.IntegrationEditionMaskedTests;

namespace JE.Tests;

/// <summary>
/// Edition round 20, part A (D53): the press a season page sends is the command that runs. An administrator's Search
/// executes exactly the intent the server checked (never parallel payload fields); the check reads the arr's queue,
/// history and episode files FRESH (bounded; "couldn't check" when they can't be read) and resolves a synthetic absent
/// season page as the page itself; a retry of a press that was already accepted gets its recorded outcome back before
/// anything is checked again (the caller's own checks kept); a movie copy whose owner can't be told is never shown as
/// someone else's download. Seerr mode (D80): Jellyfin Enhanced offers no copy-qualified ask or Search; Seerr requests
/// stay standard or 4K requests whose server Seerr picks.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionIntentTests
{
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;

    private static int Commands(FakeArr.Host host) => host.Writes.Count(w => w.Path == "/api/v3/command");

    private static CreateRequest Ask(Guid page, JsonElement? copy, string variant, int episode, string id)
        => Wiring.Body<CreateRequest>(new JsonObject
        {
            ["clientRequestId"] = id,
            ["input"] = new JsonObject
            {
                ["key"] = Firefly.ToString(), ["scope"] = "episodes", ["variant"] = variant,
                ["episodes"] = new JsonArray(new JsonObject { ["season"] = 1, ["episode"] = episode }),
            },
            ["expect"] = P.Intent(page, "get", new[] { episode }, copy, variant),
        }.ToJsonString());

    // ------------------------------------------------------------------ ED-R18-4: the executed command IS the validated intent

    [Theory]
    [InlineData("matches")]     // control: the payload says what the intent says; exactly E2 is searched on the 4K copy's Sonarr
    [InlineData("instance")]    // the payload names another instance than the one the press was checked for
    [InlineData("episodes")]    // the payload adds E4 to the checked E2
    [InlineData("episode key")] // the payload's key names E3 while the press was checked for E2
    public async Task AnAdministratorsSearchRunsOnlyTheCommandItsPressWasCheckedFor(string payload)
    {
        using var p = new P.PressRig(seerr: false);
        p.Rig.Sonarr4k!.Episodes.Add(M.Aired(104, 4));
        var page = await p.Page(p.Rig.Admin, p.FourKPage);
        var copy = P.CopyOf(page);
        var drawn = copy!.Value.GetProperty("instanceId").GetString();
        var body = new JsonObject
        {
            ["instanceId"] = payload == "instance" ? p.Rig.Arr.Instance("SonarrZ").Id : drawn,
            ["key"] = payload == "episode key" ? Firefly.WithEpisode(1, 3).ToString() : Firefly.WithSeason(1).ToString(),
            ["idempotencyKey"] = Guid.NewGuid().ToString("N"),
            ["episodes"] = payload switch { "episode key" => null, "episodes" => new JsonArray(2, 4), _ => new JsonArray(2) },
            ["expect"] = P.Intent(p.FourKPage, "search", new[] { 2 }, copy, "4k", instance: drawn),
        };
        var (status, answer) = P.Read(await p.Hub(p.Rig.Admin).Search(Wiring.Body<ManageSearchRequest>(body.ToJsonString()), default));
        if (payload == "matches")
        {
            Assert.True(status == 200, $"{status} {answer}");
            var sent = JsonNode.Parse(Assert.Single(p.Rig.Sonarr4k.Writes, w => w.Path == "/api/v3/command").Body)!;
            Assert.Equal(new[] { 102 }, sent["episodeIds"]!.AsArray().Select(n => (int)n!).ToArray());
            Assert.Equal(0, Commands(p.Rig.Sonarr));
            return;
        }
        Assert.True(status == 409 && P.Code(answer) == "press_changed", $"{payload}: {status} {answer}");
        Assert.Equal(0, Commands(p.Rig.Sonarr4k));
        Assert.Equal(0, Commands(p.Rig.Sonarr));
    }

    // ------------------------------------------------------------------ ED-R18-5: fresh facts for the check

    [Fact]
    public async Task AnAdministratorsSearchIsCheckedAgainstTheArrsQueueAsItIsNowNotTheOneInMemory()
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Admin, p.FourKPage);
        var copy = P.CopyOf(page);
        var instance = copy!.Value.GetProperty("instanceId").GetString();
        // Sonarr 4K starts downloading E2 after the page was drawn; JE's queue in memory is still warm (and empty for it).
        p.Rig.Sonarr4k!.Queue.Add(FakeArr.SonarrQueueRow(102, "just-grabbed", 1, 2, "Firefly", 78874));
        p.Rig.Sonarr4k.Queue[0]["seriesId"] = p.Rig.Sonarr4k.Series[0]["id"]!.DeepClone();
        var body = new JsonObject
        {
            ["instanceId"] = instance, ["key"] = Firefly.WithSeason(1).ToString(), ["idempotencyKey"] = Guid.NewGuid().ToString("N"),
            ["episodes"] = new JsonArray(2), ["expect"] = P.Intent(p.FourKPage, "search", new[] { 2 }, copy, "4k", instance: instance),
        };
        var (status, answer) = P.Read(await p.Hub(p.Rig.Admin).Search(Wiring.Body<ManageSearchRequest>(body.ToJsonString()), default));
        Assert.True(status == 409 && P.Code(answer) == "press_changed", $"{status} {answer}");
        Assert.Equal(0, Commands(p.Rig.Sonarr4k));
    }

    [Fact]
    public async Task AnAskIsCheckedAgainstTheArrsQueueAsItIsNowAndTheCheckReadsTheArr()
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Member, p.FourKPage);
        var body = Ask(p.FourKPage, P.CopyOf(page), "4k", 2, "warm-queue");
        p.Rig.Sonarr4k!.Queue.Add(FakeArr.SonarrQueueRow(102, "just-grabbed", 1, 2, "Firefly", 78874));
        p.Rig.Sonarr4k.Queue[0]["seriesId"] = p.Rig.Sonarr4k.Series[0]["id"]!.DeepClone();
        var before = p.Rig.Arr.CallCount(pathPart: "/api/v3/queue");
        var (status, answer) = P.Read(await p.Asks(p.Rig.Member).Create(body, default));
        Assert.True(p.Rig.Arr.CallCount(pathPart: "/api/v3/queue") > before, "the check read the queue from the arr");
        Assert.True(status == 409 && P.Code(answer) == "press_changed", $"{status} {answer}");
        Assert.Empty(p.Ledger.ForTitle(Firefly.ToString()));
    }

    [Fact]
    public async Task APressWhoseArrFactsCantBeReadNowSendsNothingAndSaysItCouldntBeChecked()
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Member, p.FourKPage);
        var body = Ask(p.FourKPage, P.CopyOf(page), "4k", 2, "arr-down");
        p.Rig.Sonarr4k!.FailWith = 503;
        var (status, answer) = P.Read(await p.Asks(p.Rig.Member).Create(body, default));
        Assert.True(status == 409 && P.Code(answer) == "press_unverified", $"{status} {answer}");
        Assert.Empty(p.Ledger.ForTitle(Firefly.ToString()));
    }

    [Fact]
    public async Task RoutineRefreshesThatChangeNoFactStillLetThePressThrough()
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Member, p.FourKPage);
        var body = Ask(p.FourKPage, P.CopyOf(page), "4k", 2, "routine-refresh");
        p.Rig.View.Rev += 5;
        p.Rig.Arr.Now = p.Rig.Arr.Now.AddSeconds(30);
        var instance = p.Rig.Arr.Instance("Sonarr4kZ");
        await p.Rig.Store.RefreshForEventAsync(instance.Id, ArrSnapshotKind.Queue, force: true);
        await p.Rig.Store.RefreshLibraryNowAsync(instance, default);
        var (status, answer) = P.Read(await p.Asks(p.Rig.Member).Create(body, default));
        Assert.True(status is 200 or 201, $"{status} {P.Code(answer)}");
    }

    // ------------------------------------------------------------------ ED-R18-6: a synthetic absent season page is resolved as itself

    private sealed class Pages(params AbsentTitle[] pages) : IAbsentTitlePages
    {
        public bool Unavailable { get; set; }

        public Task<AbsentPageResult> ResolveAsync(Guid viewerId, Guid id, CancellationToken ct)
            => Task.FromResult(Unavailable ? AbsentPageResult.Unavailable
                : pages.FirstOrDefault(x => x.PageId == id) is { } page ? new AbsentPageResult(AbsentLookup.Found, page) : AbsentPageResult.NotAbsent);
    }

    private static T WithPages<T>(T controller, IAbsentTitlePages pages) where T : ControllerBase
    {
        controller.HttpContext.RequestServices = new ServiceCollection().AddSingleton(pages).BuildServiceProvider();
        return controller;
    }

    [Theory]
    [InlineData("unchanged")]   // the Get it the absent season page drew is accepted
    [InlineData("downloading")] // Sonarr started downloading the episode since: changed
    [InlineData("unavailable")] // the page's metadata can't be read now: couldn't check
    public async Task AnAbsentSeasonPagesPressIsCheckedAgainstThatPage(string change)
    {
        using var p = new P.PressRig(seerr: false);
        var key = TitleKey.Parse("tv:tmdb:9999")!;
        var page = new AbsentTitle
        {
            PageId = Guid.NewGuid(), SeriesPageId = Guid.NewGuid(), Kind = "season", Title = key, Season = 1, TmdbId = 9999, Rows = true,
            Episodes = new[] { new AbsentEpisode(1, 2, p.Rig.Now.AddDays(-100), Guid.NewGuid()) },
        };
        var pages = new Pages(page);
        var drawn = Assert.Single(M.Items(await p.Status.ForAbsentAsync(p.Rig.Member, page, default)));
        Assert.Contains(drawn.GetProperty("episodes").EnumerateArray(), e => e.GetProperty("episode").GetInt32() == 2 && e.GetProperty("stage").GetString() == "notHere");
        if (change == "downloading")
        {
            // The series is in Sonarr now and its E2 is downloading.
            p.Rig.Sonarr.Series.Add(new JsonObject { ["id"] = 77, ["title"] = "Absent", ["tmdbId"] = 9999, ["tvdbId"] = 0, ["monitored"] = true, ["path"] = "/tv/Absent", ["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 1, ["monitored"] = true }) });
            p.Rig.Sonarr.Episodes.Add(new JsonObject { ["id"] = 7702, ["seriesId"] = 77, ["seasonNumber"] = 1, ["episodeNumber"] = 2, ["monitored"] = true, ["hasFile"] = false, ["airDateUtc"] = p.Rig.Now.AddDays(-100).ToString("o") });
            var row = FakeArr.SonarrQueueRow(7702, "absent-grab", 1, 2, "Absent", 0);
            row["seriesId"] = 77;
            p.Rig.Sonarr.Queue.Add(row);
            await p.Rig.Store.RefreshLibraryNowAsync(p.Rig.Arr.Instance("SonarrZ"), default);
        }
        if (change == "unavailable") pages.Unavailable = true;
        var body = new JsonObject
        {
            ["clientRequestId"] = Guid.NewGuid().ToString("N"),
            ["input"] = new JsonObject { ["key"] = key.ToString(), ["scope"] = "episodes", ["variant"] = "standard", ["episodes"] = new JsonArray(new JsonObject { ["season"] = 1, ["episode"] = 2 }) },
            ["expect"] = P.Intent(page.PageId, "get", new[] { 2 }, null, "standard"),
        };
        var (http, result) = P.Read(await WithPages(p.Asks(p.Rig.Member), pages).Create(Wiring.Body<CreateRequest>(body.ToJsonString()), default));
        switch (change)
        {
            case "unchanged":
                Assert.True(http == 201, $"{http} {result}");
                Assert.Single(p.Ledger.ForTitle(key.ToString()));
                break;
            case "downloading":
                Assert.True(http == 409 && P.Code(result) == "press_changed", $"{http} {result}");
                Assert.Empty(p.Ledger.ForTitle(key.ToString()));
                break;
            default:
                Assert.True(http == 409 && P.Code(result) == "press_unverified", $"{http} {result}");
                Assert.Empty(p.Ledger.ForTitle(key.ToString()));
                break;
        }
    }

    // ------------------------------------------------------------------ ED-R18-7: replay before revalidation

    [Theory]
    [InlineData("standard")]
    [InlineData("4k")]
    public async Task ARetryOfAnAcceptedAskGetsItsReceiptAfterTheEpisodeArrived(string variant)
    {
        using var p = new P.PressRig(seerr: false);
        var fourK = variant == "4k";
        var pageId = fourK ? p.FourKPage : p.StandardPage;
        var episode = fourK ? 2 : 3;
        var page = await p.Page(p.Rig.Member, pageId);
        var body = Ask(pageId, P.CopyOf(page), variant, episode, "lost-answer-" + variant);
        var (first, receipt) = P.Read(await p.Asks(p.Rig.Member).Create(body, default));
        Assert.True(first is 200 or 201, $"{first} {receipt}");
        // The answer was lost; before the browser retries with the same clientRequestId the episode arrives.
        p.Rig.View.AddEpisodeFile(fourK ? p.Rig.UhdCopy : p.Rig.HdCopy, Firefly, 1, episode, fourK ? 3840 : 1920, fourK ? 2160 : 1080, p.Rig.Now);
        p.Rig.View.Rev++;
        var (retry, answer) = P.Read(await p.Asks(p.Rig.Member).Create(body, default));
        Assert.True(retry == 200, $"retry said {retry} {P.Code(answer)}");
        Assert.Equal(receipt.GetProperty("requestId").GetString(), answer.GetProperty("requestId").GetString());
        Assert.Single(p.Ledger.ForTitle(Firefly.ToString()));
    }

    [Fact]
    public async Task ARetryOfAnAskKeepsTheCallersOwnChecks()
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Member, p.FourKPage);
        var body = Ask(p.FourKPage, P.CopyOf(page), "4k", 2, "retry-after-role");
        var (first, _) = P.Read(await p.Asks(p.Rig.Member).Create(body, default));
        Assert.True(first is 200 or 201);
        // Their role became one that may not ask: the retry is refused like any ask of theirs (no receipt replayed).
        p.Policy.People[p.Rig.Member.UserId] = p.Policy.People[p.Rig.Member.UserId] with { Role = "Watcher" };
        var (retry, answer) = P.Read(await p.Asks(p.Rig.Member).Create(body, default));
        Assert.True(retry == 403, $"{retry} {answer}");
    }

    [Fact]
    public async Task ARetryOfAnAdministratorsSearchGetsItsOutcomeAfterTheEpisodeArrived()
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Admin, p.FourKPage);
        var copy = P.CopyOf(page);
        var instance = copy!.Value.GetProperty("instanceId").GetString();
        var body = Wiring.Body<ManageSearchRequest>(new JsonObject
        {
            ["instanceId"] = instance, ["key"] = Firefly.WithEpisode(1, 2).ToString(), ["idempotencyKey"] = "same-search-retry",
            ["expect"] = P.Intent(p.FourKPage, "search", new[] { 2 }, copy, "4k", instance: instance),
        }.ToJsonString());
        var (first, _) = P.Read(await p.Hub(p.Rig.Admin).Search(body, default));
        Assert.Equal(200, first);
        p.Rig.View.AddEpisodeFile(p.Rig.UhdCopy, Firefly, 1, 2, 3840, 2160, p.Rig.Now);
        p.Rig.View.Rev++;
        var (retry, answer) = P.Read(await p.Hub(p.Rig.Admin).Search(body, default));
        Assert.True(retry == 200, $"retry said {retry} {P.Code(answer)}");
        Assert.Equal(1, Commands(p.Rig.Sonarr4k!));
    }

    [Fact]
    public async Task ARetryOfAHouseholdSearchGetsItsOutcomeAfterTheEpisodeArrived()
    {
        using var p = new P.PressRig(seerr: false);
        // A household Search needs a sent request covering the standard copy's E3.
        var input = new MutationInput { Key = Firefly.ToString(), Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 3) } };
        Assert.True((await p.Requests.CreateAsync(p.Rig.Member.UserId, new("household-sent", input), default)).HttpStatus is 200 or 201);
        await new RequestOutbox(p.Ledger, p.Policy, new IntegrationRequestLedgerTests.Backend(), new RequestTitleLocks(), p.Feed, new ArrAuditLog(Path.Combine(p.Rig.Arr.Plugin.Core.Root, "outbox-" + Guid.NewGuid().ToString("N") + ".jsonl"), 100000, 1), () => p.Rig.Arr.Now).TickAsync(default);
        p.Rig.Sonarr.Episodes.Single(e => (int)e["id"]! == 103)["monitored"] = true;
        p.Rig.Arr.Now = p.Rig.Arr.Now.AddDays(3);
        await p.Rig.Store.RefreshLibraryNowAsync(p.Rig.Arr.Instance("SonarrZ"), default);
        var page = await p.Page(p.Rig.Member, p.StandardPage);
        var copy = P.CopyOf(page);
        var body = Wiring.Body<RequestSearchBody>(new JsonObject { ["key"] = Firefly.WithEpisode(1, 3).ToString(), ["idempotencyKey"] = "household-retry", ["expect"] = P.Intent(p.StandardPage, "search", new[] { 3 }, copy, "standard") }.ToJsonString());
        var first = await p.Asks(p.Rig.Member).Search(body, default);
        var (firstStatus, firstAnswer) = P.Read(first);
        Assert.True(firstStatus == 200 && P.Code(firstAnswer) == "searched", $"first press: {firstStatus} {firstAnswer}");
        p.Rig.View.AddEpisodeFile(p.Rig.HdCopy, Firefly, 1, 3, 1920, 1080, p.Rig.Now);
        p.Rig.View.Rev++;
        var (retry, answer) = P.Read(await p.Asks(p.Rig.Member).Search(body, default));
        Assert.True(retry == 200 && P.Code(answer) == "searched", $"retry said {retry} {answer}");
        Assert.Equal(1, Commands(p.Rig.Sonarr));
    }

    // ------------------------------------------------------------------ ED-R18-1: uncertain ownership is not absence

    [Fact]
    public async Task AMovieCopyNoOneCanAttributeKeepsItsDownloadFromAViewerWhoCantOpenIt()
    {
        using var r = new IntegrationEditionAvailabilityTests.Rig(IntegrationEditionAvailabilityTests.Layout.SeparateLibraries, IntegrationEditionAvailabilityTests.Has.Both, true);
        var kid = r.View.AddUser(false, parental: true);
        SharedUnmappedLibrary(r);
        // The 4K Radarr has no file now (moved, a new database, an unmapped import) and downloads; its copy may be the hidden one.
        r.Radarr4k!.Movies[0]["hasFile"] = false;
        r.Radarr4k.Queue.Add(FakeArr.RadarrQueueRow(1, 45745, "hidden-four-k-download"));
        Assert.Null(r.View.Resolve(r.UhdCopy, kid));
        var answer = await r.Requested(IntegrationEditionAvailabilityTests.Part.Movie, true, kid);
        Assert.True(answer.Status.Stage != StatusStage.Downloading && answer.Status.Progress == null, $"{answer.Status.Stage} {answer.Status.Progress?.Percent}");
    }

    [Fact]
    public async Task AMovieDownloadOfACopyNobodyHidesIsStillShownWhenOwnershipCantBeTold()
    {
        // Control: the same shared, unmapped library, but no copy is hidden from the viewer (the 4K one isn't in Jellyfin).
        using var r = new IntegrationEditionAvailabilityTests.Rig(IntegrationEditionAvailabilityTests.Layout.SeparateLibraries, IntegrationEditionAvailabilityTests.Has.Both, true);
        var kid = r.View.AddUser(false, parental: true);
        SharedUnmappedLibrary(r, hideUhd: false);
        r.View.CopiesByKey["movie:tmdb:45745"].RemoveAll(c => c.Copy.ItemId == r.UhdCopy);
        r.View.Rev++;
        r.Radarr4k!.Movies[0]["hasFile"] = false;
        r.Radarr4k.Queue.Add(FakeArr.RadarrQueueRow(1, 45745, "four-k-download"));
        var answer = await r.Requested(IntegrationEditionAvailabilityTests.Part.Movie, true, kid);
        Assert.Equal(StatusStage.Downloading, answer.Status.Stage);
    }

    [Fact]
    public async Task AMoviePagesOtherCopyLineNeverShowsADownloadOfACopyThatMayBeHidden()
    {
        using var r = new IntegrationEditionAvailabilityTests.Rig(IntegrationEditionAvailabilityTests.Layout.SeparateLibraries, IntegrationEditionAvailabilityTests.Has.Both, true);
        var kid = r.View.AddUser(false, parental: true);
        SharedUnmappedLibrary(r);
        r.Radarr4k!.Movies[0]["hasFile"] = false;
        r.Radarr4k.Queue.Add(FakeArr.RadarrQueueRow(1, 45745, "hidden-four-k-download"));
        await r.Service.ForItemAsync(kid, r.HdCopy, default);
        await Task.Delay(30);
        var page = Assert.Single(M.Items(await r.Service.ForItemAsync(kid, r.HdCopy, default)));
        Assert.DoesNotContain("hidden-four-k-download", page.ToString());
        Assert.False(page.TryGetProperty("progress", out var progress) && progress.ValueKind == JsonValueKind.Object, page.ToString());
    }

    /// <summary>Both Radarrs link one library and map no paths (different container roots): which copy is whose can't be told.</summary>
    private static void SharedUnmappedLibrary(IntegrationEditionAvailabilityTests.Rig r, bool hideUhd = true)
    {
        var key = TitleKey.Parse("movie:tmdb:45745")!;
        var library = Guid.NewGuid().ToString("N");
        var copies = r.View.CopiesByKey[key.ToString()];
        for (var i = 0; i < copies.Count; i++)
        {
            var c = copies[i].Copy;
            copies[i] = (new JfCopy { ItemId = c.ItemId, Path = c.Path, LibraryId = library, LibraryName = "Movies", DateCreated = c.DateCreated },
                hideUhd && c.ItemId == r.UhdCopy ? new HashSet<Guid> { r.Admin.UserId } : null);
        }
        if (hideUhd) r.View.Items[r.UhdCopy] = r.View.Items[r.UhdCopy] with { VisibleTo = new HashSet<Guid> { r.Admin.UserId } };
        var config = r.Arr.Plugin.Plugin.Configuration;
        var rows = JsonNode.Parse(config.RadarrInstances)!.AsArray();
        foreach (var row in rows)
        {
            row!["LinkedLibraryIds"] = new JsonArray(library);
            row["PathMappings"] = new JsonArray();
        }
        config.RadarrInstances = rows.ToJsonString();
    }

    // ------------------------------------------------------------------ D80: Seerr mode offers no copy-qualified ask or Search

    [Fact]
    public async Task InSeerrModeASeasonsCopyBindingOffersNoAskNoSearchAndNoInstance()
    {
        using var p = new P.PressRig(seerr: true);
        foreach (var viewer in new[] { p.Rig.Member, p.Rig.Admin })
        {
            var page = await p.Page(viewer, p.FourKPage);
            var copy = P.CopyOf(page);
            Assert.True(copy is { } k && k.ValueKind == JsonValueKind.Object, $"the 4K page still names its copy: {page}");
            Assert.False(copy!.Value.GetProperty("ask").GetBoolean(), copy.Value.ToString());
            Assert.False(copy.Value.GetProperty("search").GetBoolean(), copy.Value.ToString());
            Assert.False(copy.Value.TryGetProperty("dest", out var dest) && dest.ValueKind == JsonValueKind.String, copy.Value.ToString());
            Assert.False(copy.Value.TryGetProperty("instanceId", out var id) && id.ValueKind == JsonValueKind.String, copy.Value.ToString());
        }
    }

    [Fact]
    public async Task InSeerrModeACopyQualifiedPressIsRefusedAndNothingIsRecorded()
    {
        using var p = new P.PressRig(seerr: true);
        var page = await p.Page(p.Rig.Member, p.FourKPage);
        var copy = P.CopyOf(page);
        var body = new JsonObject
        {
            ["clientRequestId"] = Guid.NewGuid().ToString("N"),
            ["input"] = new JsonObject { ["key"] = Firefly.ToString(), ["scope"] = "seasons", ["variant"] = "4k", ["seasons"] = new JsonArray(1), ["episodes"] = new JsonArray() },
            ["expect"] = new JsonObject { ["item"] = p.FourKPage.ToString("N"), ["mode"] = "get", ["episodes"] = new JsonArray(2), ["copy"] = "4k", ["variant"] = "4k", ["dest"] = "anything", ["seasons"] = new JsonArray(1) },
        };
        var (status, answer) = P.Read(await p.Asks(p.Rig.Member).Create(Wiring.Body<CreateRequest>(body.ToJsonString()), default));
        Assert.True(status == 409 && P.Code(answer) == "press_changed", $"{status} {answer} (drawn {copy})");
        Assert.Empty(p.Ledger.ForTitle(Firefly.ToString()));
    }

    [Theory]
    [InlineData(32 | 4096)]
    [InlineData(32 | 4096 | 8192)]
    public async Task InSeerrModeAFourKRequestGoesToSeerrWhichPicksItsServer(long permissions)
    {
        using var lab = new IntegrationRequestBackendsTests.SeerrLab(permissions);
        lab.Seerr.Settings["series4kEnabled"] = true;
        lab.Seerr.Shows[1731] = new JsonObject { ["id"] = 1731, ["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 1 }), ["mediaInfo"] = new JsonObject { ["status"] = 1, ["status4k"] = 1, ["seasons"] = new JsonArray(), ["requests"] = new JsonArray() } };
        // Seerr's 4K default is another server than when anything was shown: Seerr decides, JE neither names nor holds.
        lab.Seerr.SonarrServers = new JsonArray(FakeSeerr.Server(0, "sonarr.lan", 8989, false, true), FakeSeerr.Server(1, "sonarr4k.lan", 8989, true, false), FakeSeerr.Server(2, "sonarr4k-b.lan", 8989, true, true));
        var job = lab.Job(new MutationInput { Key = "tv:tmdb:1731", Scope = "seasons", Seasons = new[] { 1 }, Variant = "4k" });
        var result = await lab.Backend.SendAsync(job, () => null, default);
        var (_, _, posted) = Assert.Single(lab.Seerr.Posts);
        Assert.True((bool)posted["is4k"]!);
        Assert.False(posted.ContainsKey("serverId"), posted.ToJsonString());
        Assert.NotEqual("destination_changed", result.Outcome.Reason);
    }

    [Fact]
    public async Task InSeerrModeTheTitleWideSeasonAskStillWorks()
    {
        using var p = new P.PressRig(seerr: true);
        // The standard page's E1 isn't missing anywhere; a title-wide ask of the season (no copy) is Seerr's ordinary request.
        var body = new JsonObject
        {
            ["clientRequestId"] = Guid.NewGuid().ToString("N"),
            ["input"] = new JsonObject { ["key"] = Firefly.ToString(), ["scope"] = "seasons", ["variant"] = "4k", ["seasons"] = new JsonArray(1), ["episodes"] = new JsonArray() },
        };
        var (status, answer) = P.Read(await p.Asks(p.Rig.Member).Create(Wiring.Body<CreateRequest>(body.ToJsonString()), default));
        Assert.True(status is 200 or 201, $"{status} {answer}");
        Assert.Single(p.Ledger.ForTitle(Firefly.ToString()));
    }
}
