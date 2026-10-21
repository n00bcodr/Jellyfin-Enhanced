using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using P = JE.Tests.IntegrationEditionPressTests;
using M = JE.Tests.IntegrationEditionMaskedTests;

namespace JE.Tests;

/// <summary>
/// A press is one complete identity (D53, edition round 22): the person, the route, the title, the page and copy, the edition,
/// the exact scope, every routing field and the connection it was checked on. Its command runs only on that connection, its
/// read-back stays there, a retry key replays only that identity (any other request under the key is a conflict, whatever
/// route, prefix or omitted press it takes), and two identical presses at once are one owner that alone claims what runs.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionPressIdentityTests
{
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;

    private static JsonObject Ask(Guid page, JsonElement? copy, int ep, string id) => new()
    {
        ["clientRequestId"] = id,
        ["input"] = new JsonObject { ["key"] = Firefly.ToString(), ["scope"] = "episodes", ["variant"] = "standard", ["episodes"] = new JsonArray(new JsonObject { ["season"] = 1, ["episode"] = ep }) },
        ["expect"] = P.Intent(page, "get", new[] { ep }, copy, "standard"),
    };

    private static int Commands(FakeArr.Host host) => host.Writes.Count(w => w.Path == "/api/v3/command");

    /// <summary>Points an instance at another server (same id: a configuration save), optionally renaming it only.</summary>
    private static void Repoint(P.PressRig p, string instanceId, string? url, string? name = null)
    {
        var rows = JsonNode.Parse(p.Config.SonarrInstances)!.AsArray();
        var row = rows.First(x => string.Equals((string?)x!["Id"], instanceId, StringComparison.OrdinalIgnoreCase))!;
        if (url != null)
        {
            row["Url"] = url;
            row["ApiKey"] = "synthetic-replacement-key";
        }
        if (name != null) row["Name"] = name;
        p.Config.SonarrInstances = rows.ToJsonString();
    }

    /// <summary>A second server holding exactly what the 4K Sonarr holds (so reads from it look the same).</summary>
    private static FakeArr.Host Twin(P.PressRig p, string host)
    {
        var twin = p.Rig.Arr.Add(host, "Sonarr");
        foreach (var s in p.Rig.Sonarr4k!.Series) twin.Series.Add((JsonObject)s.DeepClone());
        foreach (var e in p.Rig.Sonarr4k.Episodes) twin.Episodes.Add((JsonObject)e.DeepClone());
        return twin;
    }

    private static async Task<(JsonElement? Copy, string Instance, JsonObject Body)> FourKSearch(P.PressRig p, string key, int episode = 2)
    {
        var page = await p.Page(p.Rig.Admin, p.FourKPage);
        var copy = P.CopyOf(page);
        var instance = copy!.Value.GetProperty("instanceId").GetString()!;
        var body = new JsonObject
        {
            ["instanceId"] = instance, ["key"] = Firefly.WithEpisode(1, episode).ToString(), ["idempotencyKey"] = key,
            ["expect"] = P.Intent(p.FourKPage, "search", new[] { episode }, copy, "4k", instance: instance),
        };
        return (copy, instance, body);
    }

    // ------------------------------------------------------------------ the command stays on the connection it was checked on

    // Review r21 S1: the check proved Firefly's episode 102 on the 4K Sonarr; a configuration save right after it points the
    // same instance id at another server where 102 is another show's episode. Nothing may be sent there.
    [Fact]
    public async Task ASearchRunsOnlyOnTheConnectionItsEpisodeIdsWereCheckedOn()
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Admin, p.FourKPage);
        var copy = P.CopyOf(page);
        var instance = copy!.Value.GetProperty("instanceId").GetString()!;
        var replacement = p.Rig.Arr.Add("replacement.invalid", "Sonarr");
        replacement.Series.Add(FakeArr.SeriesRow(1, 9999, "Another Show"));
        replacement.Episodes.Add(M.Aired(102, 9));
        var intent = Wiring.Body<PressIntent>(P.Intent(p.FourKPage, "search", new[] { 2 }, copy, "4k", instance: instance).ToJsonString());
        var key = Firefly.WithSeason(1);
        var fingerprint = PressChecks.RequestFingerprint(intent, PressChecks.Admin, key, null)!;
        var result = await p.Manage.SearchCommandAsync(p.Rig.Admin, null, instance, key, "retargeted-connection", fingerprint, async ct =>
        {
            var proof = await p.Status.PressAsync(p.Rig.Admin, intent, PressChecks.Admin, null, key, ct);
            Assert.Null(proof.Refusal);
            Assert.Equal(new[] { 102 }, proof.Command!.EpisodeIds);
            Repoint(p, instance, "http://replacement.invalid:8989");
            return proof;
        }, default);
        var wrong = replacement.Writes.Where(w => w.Path == "/api/v3/command").Select(w => w.Body).ToList();
        Assert.True(wrong.Count == 0, $"Ran checked Firefly ids on unvalidated replacement server: {result.Outcome.Status}; commands={string.Join(",", wrong)}");
        Assert.Equal(0, Commands(p.Rig.Sonarr4k!));
        Assert.Equal(PressChecks.Changed, result.Refusal);
    }

    // Control: a save that only renames the instance (same server, same key) changes nothing the check proved.
    [Fact]
    public async Task ARenamedInstanceStillRunsTheCheckedSearch()
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Admin, p.FourKPage);
        var copy = P.CopyOf(page);
        var instance = copy!.Value.GetProperty("instanceId").GetString()!;
        var intent = Wiring.Body<PressIntent>(P.Intent(p.FourKPage, "search", new[] { 2 }, copy, "4k", instance: instance).ToJsonString());
        var key = Firefly.WithSeason(1);
        var fingerprint = PressChecks.RequestFingerprint(intent, PressChecks.Admin, key, null)!;
        var result = await p.Manage.SearchCommandAsync(p.Rig.Admin, null, instance, key, "renamed-connection", fingerprint, async ct =>
        {
            var proof = await p.Status.PressAsync(p.Rig.Admin, intent, PressChecks.Admin, null, key, ct);
            Repoint(p, instance, url: null, name: "Sonarr 4K (renamed)");
            return proof;
        }, default);
        Assert.Null(result.Refusal);
        Assert.Equal(ArrActionStatus.Succeeded, result.Outcome.Status);
        Assert.Equal("{\"name\":\"EpisodeSearch\",\"episodeIds\":[102]}", Assert.Single(p.Rig.Sonarr4k!.Writes, w => w.Path == "/api/v3/command").Body);
    }

    // The command went out; a save then points the instance elsewhere. Its read-back (the command's state, what it grabbed)
    // is read where it was sent, never from the replacement, which could answer for a command id of its own.
    [Fact]
    public async Task ASearchsReadBackStaysOnTheConnectionItWasSentTo()
    {
        using var p = new P.PressRig(seerr: false);
        var (_, instance, body) = await FourKSearch(p, "read-back-stays");
        var twin = Twin(p, "twin.invalid");
        // The save lands while the command is being sent (it reached the 4K Sonarr), before its read-back.
        p.Rig.Sonarr4k!.Before = (path, _) =>
        {
            if (path == "/api/v3/command") Repoint(p, instance, "http://twin.invalid:8989");
            return Task.CompletedTask;
        };
        var (status, answer) = P.Read(await p.Hub(p.Rig.Admin).Search(Wiring.Body<ManageSearchRequest>(body.ToJsonString()), default));
        Assert.Equal(200, status);
        Assert.Equal(1, Commands(p.Rig.Sonarr4k));
        Assert.True(p.Rig.Arr.CallCount("twin.invalid") == 0, $"read back from the replacement: {p.Rig.Arr.CallCount("twin.invalid")} call(s); {answer}");
        Assert.True(p.Rig.Arr.CallCount("sonarr4k.lan", "/api/v3/command/") > 0, "read back where it was sent");
    }

    // The connection changes while the check is reading the instance (between its queue and history reads): the facts come
    // from two servers, so nothing proves the press; nothing is sent to either.
    [Fact]
    public async Task AConnectionChangedWhileThePressIsReadLeavesItUnverified()
    {
        using var p = new P.PressRig(seerr: false);
        var (_, instance, body) = await FourKSearch(p, "changed-mid-read");
        var twin = Twin(p, "twin-mid.invalid");
        var changed = 0;
        p.Rig.Sonarr4k!.Before = (path, _) =>
        {
            if (path.StartsWith("/api/v3/history", StringComparison.Ordinal) && Interlocked.Exchange(ref changed, 1) == 0) Repoint(p, instance, "http://twin-mid.invalid:8989");
            return Task.CompletedTask;
        };
        var (status, answer) = P.Read(await p.Hub(p.Rig.Admin).Search(Wiring.Body<ManageSearchRequest>(body.ToJsonString()), default));
        Assert.Equal(1, changed);
        Assert.True(Commands(p.Rig.Sonarr4k) == 0 && Commands(twin) == 0, $"sent on a mixed read: {status} {answer}");
        Assert.True(status == 409 && P.Code(answer) == PressChecks.Unverified, $"{status} {answer}");
    }

    // The ask form of the same boundary: the standard copy's ask was checked on the standard Sonarr's connection; a save points
    // that instance elsewhere before the ask is recorded. Nothing is recorded (no job for an unchecked server).
    [Fact]
    public async Task AnAskIsRecordedOnlyForTheConnectionItWasCheckedOn()
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Member, p.StandardPage);
        var body = Wiring.Body<CreateRequest>(Ask(p.StandardPage, P.CopyOf(page), 3, "ask-moved").ToJsonString());
        var standard = p.Rig.Arr.Instance("SonarrZ").Id;
        var outcome = await p.Requests.CreateAsync(p.Rig.Member.UserId, body, default, press: async (input, ct) =>
        {
            var proof = await p.Status.PressAsync(p.Rig.Member, body.Expect!, PressChecks.Ask, input, null, ct);
            Assert.Null(proof.Refusal);
            Repoint(p, standard, "http://elsewhere.invalid:8989");
            return proof;
        });
        Assert.True(outcome.HttpStatus == 409 && outcome.Reason == PressChecks.Changed, JsonSerializer.Serialize(outcome));
        Assert.Empty(p.Ledger.ForTitle(Firefly.ToString()));
    }

    // ------------------------------------------------------------------ one retry identity

    // Review r21 S3: an accepted ask's client id reused with the 4K instance in its input.
    [Fact]
    public async Task AnAskRetryWithAnotherRoutingInstanceIsAConflict()
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Admin, p.StandardPage);
        var body = Ask(p.StandardPage, P.CopyOf(page), 3, "route-key");
        var (first, _) = P.Read(await p.Asks(p.Rig.Admin).Create(Wiring.Body<CreateRequest>(body.ToJsonString()), default));
        Assert.True(first is 200 or 201);
        body["input"]!["instanceId"] = p.Rig.Arr.Instance("Sonarr4kZ").Id;
        var (status, answer) = P.Read(await p.Asks(p.Rig.Admin).Create(Wiring.Body<CreateRequest>(body.ToJsonString()), default));
        Assert.True(status == 409 && P.Code(answer) == PressChecks.Conflict, $"Changed routing instance replayed: {status} {answer}");
        Assert.Single(p.Ledger.ForTitle(Firefly.ToString()));
    }

    // Every field of the press is part of what the key remembers: the same id with another intent field (the whole-series
    // policy it was drawn under, the seasons it rounded to) or without its press at all is another request (409), never the
    // first ask's receipt.
    [Theory]
    [InlineData("whole")]
    [InlineData("seasons")]
    [InlineData("no press")]
    public async Task AnAskRetryWithAnotherIntentIsAConflict(string change)
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Admin, p.StandardPage);
        var body = Ask(p.StandardPage, P.CopyOf(page), 3, "intent-key");
        Assert.True(P.Read(await p.Asks(p.Rig.Admin).Create(Wiring.Body<CreateRequest>(body.ToJsonString()), default)).Status is 200 or 201);
        switch (change)
        {
            case "whole": body["expect"]!["whole"] = true; break;
            case "seasons": body["expect"]!["seasons"] = new JsonArray(1); break;
            default: body.Remove("expect"); break;
        }
        var (status, answer) = P.Read(await p.Asks(p.Rig.Admin).Create(Wiring.Body<CreateRequest>(body.ToJsonString()), default));
        Assert.True(status == 409 && P.Code(answer) == PressChecks.Conflict, $"{change}: {status} {answer}");
    }

    // Controls: the exact retry replays its receipt even after the connection it was checked on changed (nothing is checked
    // again, nothing new is recorded), and another person's identical client id is their own ask.
    [Fact]
    public async Task AnExactAskRetryReplaysAfterItsConnectionChangedAndKeysArePerPerson()
    {
        using var p = new P.PressRig(seerr: false);
        var page = await p.Page(p.Rig.Admin, p.StandardPage);
        var body = Ask(p.StandardPage, P.CopyOf(page), 3, "exact-key");
        var (first, made) = P.Read(await p.Asks(p.Rig.Admin).Create(Wiring.Body<CreateRequest>(body.ToJsonString()), default));
        Assert.True(first is 200 or 201, made.ToString());
        Repoint(p, p.Rig.Arr.Instance("SonarrZ").Id, "http://elsewhere.invalid:8989");
        var (again, replay) = P.Read(await p.Asks(p.Rig.Admin).Create(Wiring.Body<CreateRequest>(body.ToJsonString()), default));
        Assert.True(again == 200 && replay.GetProperty("requestId").GetString() == made.GetProperty("requestId").GetString(), $"{again} {replay}");
        Assert.Single(p.Ledger.ForTitle(Firefly.ToString()));
        Repoint(p, p.Rig.Arr.Instance("SonarrZ").Id, "http://sonarr.lan:8989");
        var memberPage = await p.Page(p.Rig.Member, p.StandardPage);
        var (theirs, own) = P.Read(await p.Asks(p.Rig.Member).Create(Wiring.Body<CreateRequest>(Ask(p.StandardPage, P.CopyOf(memberPage), 3, "exact-key").ToJsonString()), default));
        Assert.True(theirs is 200 or 201 && P.Code(own) != PressChecks.Conflict, $"{theirs} {own}");
    }

    // Review r21 S4: the same administrator's Search key, once with its press and once without (both orders), runs one command.
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task TheSameSearchKeyWithOrWithoutItsPressRunsOnce(bool pressFirst)
    {
        using var p = new P.PressRig(seerr: false);
        var (_, _, body) = await FourKSearch(p, "drop-expect");
        var bare = (JsonObject)body.DeepClone();
        bare.Remove("expect");
        var first = pressFirst ? body : bare;
        var second = pressFirst ? bare : body;
        Assert.Equal(200, P.Read(await p.Hub(p.Rig.Admin).Search(Wiring.Body<ManageSearchRequest>(first.ToJsonString()), default)).Status);
        var (status, answer) = P.Read(await p.Hub(p.Rig.Admin).Search(Wiring.Body<ManageSearchRequest>(second.ToJsonString()), default));
        var count = Commands(p.Rig.Sonarr4k!);
        Assert.True(count == 1, $"Same key {(pressFirst ? "without" : "with")} expect ran {count} commands: {status} {answer}");
        Assert.True(status == 409 && P.Code(answer) == PressChecks.Conflict, $"{status} {answer}");
    }

    // ------------------------------------------------------------------ household Search: one owner claims what runs

    /// <summary>
    /// E3-E53 of Firefly: requested (sent through the outbox) three days ago, monitored, aired long ago, missing from the
    /// standard copy and playing in 4K, so a standard household Search of the season page names all 51.
    /// </summary>
    private static async Task<(PressIntent Expect, ConcurrentDictionary<string, DateTimeOffset> Slots)> FiftyOneMissing(P.PressRig p)
    {
        var numbers = Enumerable.Range(3, 51).ToArray();
        p.Policy.People[p.Rig.Member.UserId] = p.Policy.People[p.Rig.Member.UserId] with { Limit = 1000 };
        foreach (var n in numbers)
        {
            if (n > 3)
            {
                p.Rig.Sonarr.Episodes.Add(M.Aired(100 + n, n));
                p.Rig.Sonarr4k!.Episodes.Add(M.Aired(100 + n, n));
                p.Rig.View.AddEpisodeFile(p.Rig.UhdCopy, Firefly, 1, n, 3840, 2160, p.Rig.Now.AddDays(-1));
            }
            p.Rig.Sonarr.Episodes.Single(e => (int)e["id"]! == 100 + n)["monitored"] = true;
            p.Rig.Sonarr.Episodes.Single(e => (int)e["id"]! == 100 + n)["airDateUtc"] = "2002-10-01T00:00:00Z";
            p.Rig.Sonarr4k!.Episodes.Single(e => (int)e["id"]! == 100 + n)["airDateUtc"] = "2002-10-01T00:00:00Z";
        }
        var input = new MutationInput { Key = Firefly.ToString(), Scope = "episodes", Episodes = numbers.Select(n => new RequestEpisode(1, n)).ToArray() };
        var made = await p.Requests.CreateAsync(p.Rig.Member.UserId, new("many-sent", input), default);
        Assert.True(made.HttpStatus is 200 or 201, JsonSerializer.Serialize(made));
        await new RequestOutbox(p.Ledger, p.Policy, new IntegrationRequestLedgerTests.Backend(), new RequestTitleLocks(), p.Feed,
            new ArrAuditLog(Path.Combine(p.Rig.Arr.Plugin.Core.Root, "identity-outbox.jsonl"), 100000, 1), () => p.Rig.Arr.Now).TickAsync(default);
        p.Rig.Arr.Now = p.Rig.Arr.Now.AddDays(3);
        await p.Rig.Store.RefreshLibraryNowAsync(p.Rig.Arr.Instance("SonarrZ"), default);
        var page = await p.Page(p.Rig.Member, p.StandardPage);
        var expect = Wiring.Body<PressIntent>(P.Intent(p.StandardPage, "search", numbers, P.CopyOf(page), "standard").ToJsonString());
        var slots = (ConcurrentDictionary<string, DateTimeOffset>)typeof(RequestSearchService).GetField("_last", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(p.Search)!;
        return (expect, slots);
    }

    private static int[] SearchedIds(FakeArr.Host host, int command)
        => JsonNode.Parse(host.Writes.Where(w => w.Path == "/api/v3/command").ElementAt(command).Body)!["episodeIds"]!.AsArray().Select(x => (int)x!).ToArray();

    // Review r21 B3: an identical second press arrives while the first has claimed 50 episodes and not yet run its command. One
    // command runs, the second inherits its result, and no slot is spent on an episode that was never searched: a later
    // press (another key) searches the remainder.
    [Fact]
    public async Task ConcurrentIdenticalSearchesSpendSlotsOnlyForEpisodesThatRan()
    {
        using var p = new P.PressRig(seerr: false);
        var title = Firefly;
        var (expect, slots) = await FiftyOneMissing(p);
        using var release = new ManualResetEventSlim();
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = 0;
        p.Policy.Adjust = (_, _, facts) =>
        {
            // The first press's final check: it claimed 50 parts and holds them while it is checked again.
            if (slots.Count == 50 && Interlocked.CompareExchange(ref held, 1, 0) == 0)
            {
                reached.TrySetResult();
                Assert.True(release.Wait(TimeSpan.FromSeconds(15)), "the first press was never released");
            }
            return facts;
        };
        var first = Task.Run(() => p.Search.SearchAsync(p.Rig.Member, title.WithSeason(1).ToString(), "same-click", default, expect));
        Task<(RequestOutcome Outcome, bool? Found)> second;
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            second = Task.Run(() => p.Search.SearchAsync(p.Rig.Member, title.WithSeason(1).ToString(), "same-click", default, expect));
            // While the first owns the press, the identical second claims nothing of its own.
            await Task.WhenAny(second, Task.Delay(300));
            Assert.Equal(50, slots.Count);
        }
        finally { release.Set(); }
        Assert.Equal("searched", (await first).Outcome.Reason);
        Assert.Equal("searched", (await second).Outcome.Reason);
        Assert.Single(p.Rig.Sonarr.Writes, w => w.Path == "/api/v3/command");
        var next = await p.Search.SearchAsync(p.Rig.Member, title.WithSeason(1).ToString(), "next-click", default, expect);
        Assert.True(next.Outcome.Reason == "searched", $"one command ran, but {slots.Count} episode slots were spent: {JsonSerializer.Serialize(next.Outcome)}");
    }

    // The owner's caller goes away before its command: it releases what it claimed, and the identical retry waiting on it
    // becomes the owner and searches the first 50 itself (nothing was searched before it).
    [Fact]
    public async Task ACancelledFirstPressLeavesItsIdenticalRetryToSearch()
    {
        using var p = new P.PressRig(seerr: false);
        var (expect, slots) = await FiftyOneMissing(p);
        using var release = new ManualResetEventSlim();
        using var gone = new CancellationTokenSource();
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = 0;
        p.Policy.Adjust = (_, _, facts) =>
        {
            if (slots.Count == 50 && Interlocked.CompareExchange(ref held, 1, 0) == 0)
            {
                reached.TrySetResult();
                Assert.True(release.Wait(TimeSpan.FromSeconds(15)), "the first press was never released");
            }
            return facts;
        };
        var first = Task.Run(() => p.Search.SearchAsync(p.Rig.Member, Firefly.WithSeason(1).ToString(), "cancelled-click", gone.Token, expect));
        Task<(RequestOutcome Outcome, bool? Found)> retry;
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            retry = Task.Run(() => p.Search.SearchAsync(p.Rig.Member, Firefly.WithSeason(1).ToString(), "cancelled-click", default, expect));
            await Task.WhenAny(retry, Task.Delay(300));
            gone.Cancel();
        }
        finally { release.Set(); }
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);
        Assert.Equal("searched", (await retry).Outcome.Reason);
        Assert.Single(p.Rig.Sonarr.Writes, w => w.Path == "/api/v3/command");
        Assert.True(SearchedIds(p.Rig.Sonarr, 0).Length == 50, "the retry searched the episodes the cancelled press had claimed: " + string.Join(",", SearchedIds(p.Rig.Sonarr, 0)));
        Assert.Equal(50, slots.Count);
    }

    // A household Search key is the person's key: used again for an administrator's Search (another route, no "family"
    // namespace of its own) it runs nothing more.
    [Fact]
    public async Task AHouseholdSearchKeyCannotRunAgainAsAnAdministratorsSearch()
    {
        using var p = new P.PressRig(seerr: false);
        var (expect, _) = await FiftyOneMissing(p);
        p.Policy.People[p.Rig.Admin.UserId] = p.Policy.People[p.Rig.Admin.UserId] with { Limit = 1000 };
        var household = await p.Search.SearchAsync(p.Rig.Admin, Firefly.WithSeason(1).ToString(), "one-key", default, expect);
        Assert.Equal("searched", household.Outcome.Reason);
        var page = await p.Page(p.Rig.Admin, p.StandardPage);
        var standard = p.Rig.Arr.Instance("SonarrZ").Id;
        var body = new JsonObject { ["instanceId"] = standard, ["key"] = Firefly.WithEpisode(1, 53).ToString(), ["idempotencyKey"] = "one-key" };
        var (status, answer) = P.Read(await p.Hub(p.Rig.Admin).Search(Wiring.Body<ManageSearchRequest>(body.ToJsonString()), default));
        Assert.True(Commands(p.Rig.Sonarr) == 1, $"the key ran again on another route: {status} {answer}");
    }
}
