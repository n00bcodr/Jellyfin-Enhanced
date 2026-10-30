using System.Reflection;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Rig = JE.Tests.IntegrationSeerrRequestOptionsTests.Rig;

namespace JE.Tests;

/// <summary>
/// Where a Seerr-mode request goes, applied the same way on every path (phase 4b, review round 3). A request only stands
/// for, covers, dedups, suppresses or follows another one at the same destination: the same Seerr source, and for a
/// request with administrator Seerr options the same server, quality profile, root folder and options stamp
/// (RequestDestination). An approval may re-confirm a request only on its own Seerr with only a fresh stamp,
/// and work already sent never moves. Table: path × difference (source, server, profile, root folder, stamp only, or none)
/// × the other request's state (sent, not sent yet, held for an OK). Production policy, ledger, outbox and Seerr backend
/// over a synthetic Seerr with two Sonarr servers. The source test and its mutations at the end are defence in depth (D41):
/// the runtime rows are the guarantee.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationSeerrDestinationTableTests
{
    private const string Show = "tv:tmdb:1731";

    /// <summary>How the other request's destination differs from the ask's.</summary>
    public enum Diff
    {
        /// <summary>The same destination (the control row).</summary>
        Same,
        /// <summary>Another Seerr (address or key changed), the same server, profile and folder ids.</summary>
        Source,
        /// <summary>Another Sonarr server in Seerr.</summary>
        Server,
        /// <summary>Another quality profile on the same server.</summary>
        Profile,
        /// <summary>Another root folder on the same server.</summary>
        Root,
        /// <summary>Only the options stamp: the server's facts changed between the two.</summary>
        Stamp,
    }

    /// <summary>The other request's state.</summary>
    public enum State
    {
        /// <summary>Sent to Seerr.</summary>
        Sent,
        /// <summary>Queued, not sent yet.</summary>
        Unsent,
        /// <summary>Waiting for an OK (nothing sent).</summary>
        Held,
    }

    private sealed record Place(int Server, int Profile, string Root);

    // The ask's destination, and the other request's for each difference (source and stamp: the same ids).
    private static readonly Place X = new(0, 4, "/tv");

    private static Place Y(Diff diff) => diff switch
    {
        Diff.Server => new(1, 4, "/tv"),
        Diff.Profile => new(0, 7, "/tv"),
        Diff.Root => new(0, 4, "/tv-anime"),
        _ => X,
    };

    public static TheoryData<Diff, State> Every()
    {
        var rows = new TheoryData<Diff, State>();
        foreach (var diff in Enum.GetValues<Diff>())
            foreach (var state in Enum.GetValues<State>()) rows.Add(diff, state);
        return rows;
    }

    // Seerr has two Sonarr servers: the default one (profiles 4 and 7, folders /tv and /tv-anime) and an anime one.
    private static Rig NewRig()
    {
        var rig = new Rig();
        static JsonObject Server(int id, string name, bool isDefault)
            => new() { ["id"] = id, ["name"] = name, ["is4k"] = false, ["isDefault"] = isDefault, ["activeProfileId"] = 4, ["activeDirectory"] = "/tv", ["activeTags"] = new JsonArray() };
        static JsonObject Details(JsonObject server, int[] profiles, params string[] roots)
            => new()
            {
                ["server"] = server.DeepClone(),
                ["profiles"] = new JsonArray(profiles.Select(p => (JsonNode)new JsonObject { ["id"] = p, ["name"] = "Profile " + p }).ToArray()),
                ["rootFolders"] = new JsonArray(roots.Select((r, i) => (JsonNode)new JsonObject { ["id"] = i + 1, ["path"] = r, ["freeSpace"] = 1_000_000 }).ToArray()),
                ["tags"] = new JsonArray(),
            };
        var main = Server(0, "Sonarr", true);
        var anime = Server(1, "Sonarr Anime", false);
        rig.Fake.Services["sonarr"] = new JsonArray(main.DeepClone(), anime.DeepClone());
        rig.Fake.ServiceDetails["sonarr/0"] = Details(main, new[] { 4, 7 }, "/tv", "/tv-anime");
        rig.Fake.ServiceDetails["sonarr/1"] = Details(anime, new[] { 4 }, "/tv");
        static JsonObject Season(int n, string aired) => new() { ["seasonNumber"] = n, ["episodeCount"] = 8, ["airDate"] = aired };
        rig.Fake.Shows[1731] = new JsonObject { ["id"] = 1731, ["seasons"] = new JsonArray(Season(1, "2020-01-01"), Season(2, "2021-01-01"), Season(3, "2027-03-01")) };
        return rig;
    }

    // A second Jellyfin administrator with Seerr's admin permission (added before anything reads Seerr's users).
    private static StatusViewer SecondAdmin(Rig rig)
    {
        var admin = rig.View.AddUser(true);
        rig.Fake.Users.Add(new JsonObject { ["id"] = 12, ["jellyfinUserId"] = admin.UserId.ToString("N"), ["permissions"] = 2, ["displayName"] = "Admin 2" });
        return admin;
    }

    // Between the other request and the ask: Seerr's main Sonarr gets another root folder (every stamp of it changes), or
    // Jellyfin Enhanced points at another Seerr. Seerr's servers are read again either way.
    private static void Apply(Rig rig, Diff diff)
    {
        if (diff == Diff.Stamp) ChangeFacts(rig);
        if (diff == Diff.Source) rig.Config.JellyseerrUrls = "http://seerr-b.lan:5055";
        rig.Lab.Now = rig.Lab.Now.AddMinutes(2);
    }

    private static void ChangeFacts(Rig rig)
        => ((JsonArray)rig.Fake.ServiceDetails["sonarr/0"]["rootFolders"]!).Add(new JsonObject { ["id"] = 9, ["path"] = "/tv-kids", ["freeSpace"] = 1_000_000 });

    // A season starts in Seerr (it has aired).
    private static void Starts(Rig rig, int season)
    {
        rig.Fake.Shows[1731]["seasons"]!.AsArray()[season - 1]!["airDate"] = "2026-10-01";
        rig.Lab.Now = rig.Lab.Now.AddMinutes(2);
    }

    private static async Task<MutationInput> At(Rig rig, Place place, string scope, params int[] seasons)
        => new() { Key = Show, Scope = scope, Seasons = seasons, SeerrServerId = place.Server, SeerrProfileId = place.Profile, SeerrRootFolder = place.Root, SeerrOptions = await rig.Stamp(place.Server, movie: false) };

    // The other request, in its state: sent, queued (no send pass yet), or waiting for an OK (ask mode).
    private static async Task<string> Other(Rig rig, StatusViewer who, MutationInput input, State state)
    {
        var outcome = state == State.Held
            ? await rig.Service.CreateAsync(who.UserId, new(Guid.NewGuid().ToString("N"), input), default, new RequestOrigin(RequestOrigin.InteractiveKind) { RequireApproval = true })
            : await rig.Ask(who, input);
        Assert.True(outcome.HttpStatus == 201, outcome.Reason + ": " + outcome.Message);
        if (state == State.Sent) await rig.Outbox.TickAsync(default);
        Assert.Equal(state switch { State.Sent => "sent", State.Unsent => "queued", _ => "pending" }, rig.Ledger.Find(outcome.RequestId!)!.Status);
        return outcome.RequestId!;
    }

    private static FutureSeasonCharges Follower(Rig rig)
        => new(rig.Lab.Arr.Store, rig.Ledger, rig.Policy, rig.Lab.Arr.Arr.Factory, new ArrChangeFeed(), null, null, () => rig.Lab.Now, rig.Seerr, rig.Lab.Model, new RequestOutboxSignal());

    private static bool Goes(JsonObject post, Place place)
        => (int?)post["serverId"] == place.Server && (int?)post["profileId"] == place.Profile && (string?)post["rootFolder"] == place.Root;

    // ------------------------------------------------------------------ own-request dedup (B7, B5)

    [Theory]
    [MemberData(nameof(Every))]
    public async Task OwnDedupAnswersWithARequestAtTheAsksDestinationAloneOrTogether(Diff diff, State state)
    {
        using var rig = NewRig();
        // The administrator's own season 1 request elsewhere comes first.
        var other = await Other(rig, rig.Admin, await At(rig, Y(diff), "seasons", 1), state);
        Apply(rig, diff);
        var one = await rig.Ask(rig.Admin, await At(rig, X, "seasons", 1));
        var two = await rig.Ask(rig.Admin, await At(rig, X, "seasons", 2));
        // Seasons 1 and 2 together are already recorded: by requests at that destination only.
        var both = await rig.Ask(rig.Admin, await At(rig, X, "seasons", 1, 2));
        Assert.Equal(200, both.HttpStatus);
        if (diff == Diff.Same)
        {
            Assert.Equal(other, one.RequestId);
            Assert.Contains(both.RequestId, new[] { other, two.RequestId });
            return;
        }
        Assert.NotEqual(other, one.RequestId);
        Assert.Contains(both.RequestId, new[] { one.RequestId, two.RequestId });
    }

    [Theory]
    [MemberData(nameof(Every))]
    public async Task AnOwnRequestElsewhereIsNeverTheAskAndTheAskGoesWhereItWasChosen(Diff diff, State state)
    {
        using var rig = NewRig();
        var other = await Other(rig, rig.Admin, await At(rig, Y(diff), "seasons", 1, 2), state);
        Apply(rig, diff);
        var ask = await rig.Ask(rig.Admin, await At(rig, X, "seasons", 1, 2));
        if (diff == Diff.Same)
        {
            Assert.Equal((other, 200), (ask.RequestId, ask.HttpStatus));
            return;
        }
        Assert.True(ask.HttpStatus == 201, ask.Reason + ": " + ask.Message);
        Assert.NotEqual(other, ask.RequestId);
        var job = Assert.Single(rig.Ledger.ForWant(ask.RequestId!));
        Assert.Equal((X.Server, X.Profile, X.Root, await rig.Stamp(0, movie: false)), (job.Input.SeerrServerId, job.Input.SeerrProfileId, job.Input.SeerrRootFolder, job.Input.SeerrOptions));
    }

    // ------------------------------------------------------------------ someone else's request (shared coverage, shared dispatch)

    [Theory]
    [MemberData(nameof(Every))]
    public async Task SomeoneElsesRequestElsewhereNeverCoversTheAskOrSendsItWithIts(Diff diff, State state)
    {
        using var rig = NewRig();
        var admin2 = SecondAdmin(rig);
        await Other(rig, admin2, await At(rig, Y(diff), "seasons", 1), state);
        Apply(rig, diff);
        var ask = await rig.Ask(rig.Admin, await At(rig, X, "seasons", 1));
        var want = rig.Ledger.Find(ask.RequestId!)!;
        if (diff == Diff.Same && state != State.Held)
        {
            // At the same destination it follows the other request (no send of its own).
            Assert.True(want.Follower);
            Assert.Empty(rig.Ledger.ForWant(ask.RequestId!));
            return;
        }
        Assert.True(ask.HttpStatus == 201 && ask.Outcome != "merged", ask.Outcome + ": " + ask.Message);
        Assert.False(want.Follower);
        Assert.Single(rig.Ledger.ForWant(ask.RequestId!));
        // Its own send goes out with its own choice, as the administrator.
        var before = rig.Fake.Posts.Count;
        await rig.Outbox.TickAsync(default);
        Assert.Contains(rig.Fake.Posts.Skip(before), p => p.ApiUser == "9" && Goes(p.Body, X));
    }

    // ------------------------------------------------------------------ keep-getting follows (B8)

    public static TheoryData<Diff, State> FollowRows()
    {
        var rows = new TheoryData<Diff, State>();
        foreach (var diff in Enum.GetValues<Diff>())
            foreach (var state in Enum.GetValues<State>())
            {
                // A request queued at the Seerr Jellyfin Enhanced pointed at before can't stay queued across a send pass:
                // the pass that sends the keep-getting request holds it (identity_changed), so it is the held row.
                if (diff == Diff.Source && state == State.Unsent) continue;
                rows.Add(diff, state);
            }
        return rows;
    }

    [Theory]
    [MemberData(nameof(FollowRows))]
    public async Task OnlyARequestAtTheSameDestinationKeepsAKeepGettingRequestFromFollowingANewSeason(Diff diff, State state)
    {
        using var rig = NewRig();
        var admin2 = SecondAdmin(rig);
        // The other request: season 3 (not started yet), by someone else. Before the keep-getting request at the other
        // Seerr; after it otherwise (the other stamp is the newer one).
        string keep;
        if (diff == Diff.Source)
        {
            await Other(rig, admin2, await At(rig, Y(diff), "seasons", 3), state);
            Apply(rig, diff);
            keep = (await rig.Ask(rig.Admin, await At(rig, X, "future", 2))).RequestId!;
            await rig.Outbox.TickAsync(default);
        }
        else
        {
            keep = (await rig.Ask(rig.Admin, await At(rig, X, "future", 2))).RequestId!;
            await rig.Outbox.TickAsync(default);
            Apply(rig, diff);
            await Other(rig, admin2, await At(rig, Y(diff), "seasons", 3), state);
        }
        Assert.Equal("sent", rig.Ledger.Find(keep)!.Status);
        Starts(rig, 3);
        var queued = await Follower(rig).FollowSeerrAsync(default);
        // Followed unless a request at the same destination has season 3, or Seerr already has it from anyone
        // (Q-4BFIX2-3: a sent request, wherever it went).
        Assert.Equal(diff == Diff.Same || state == State.Sent ? 0 : 1, queued);
        if (queued == 1)
        {
            var season3 = Assert.Single(rig.Ledger.ForWant(keep), j => j.Input.Seasons.SequenceEqual(new[] { 3 }));
            Assert.Equal((X.Server, X.Profile, X.Root), (season3.Input.SeerrServerId, season3.Input.SeerrProfileId, season3.Input.SeerrRootFolder));
        }
    }

    [Theory]
    [InlineData(Diff.Same)]
    [InlineData(Diff.Server)]
    [InlineData(Diff.Profile)]
    [InlineData(Diff.Root)]
    [InlineData(Diff.Stamp)]
    public async Task TwoKeepGettingRequestsAtDifferentDestinationsEachFollowTheNewSeasonInOnePass(Diff diff)
    {
        using var rig = NewRig();
        // Season 1 kept getting at one destination, season 2 at the other (each sent), then season 3 starts.
        var first = (await rig.Ask(rig.Admin, await At(rig, X, "future", 1))).RequestId!;
        await rig.Outbox.TickAsync(default);
        Apply(rig, diff);
        var second = await rig.Ask(rig.Admin, await At(rig, Y(diff), "future", 2));
        Assert.True(second.HttpStatus == 201, second.Reason + ": " + second.Message);
        await rig.Outbox.TickAsync(default);
        Assert.Equal(("sent", "sent"), (rig.Ledger.Find(first)!.Status, rig.Ledger.Find(second.RequestId!)!.Status));
        Starts(rig, 3);
        // The first one's new season, queued in the same pass, stands for the second one's only at the same destination.
        Assert.Equal(diff == Diff.Same ? 1 : 2, await Follower(rig).FollowSeerrAsync(default));
    }

    // ------------------------------------------------------------------ approvals: one re-confirmation rule (security-r3-1, B9)

    public static TheoryData<Diff, State, bool> ApprovalRows()
    {
        var rows = new TheoryData<Diff, State, bool>();
        foreach (var state in Enum.GetValues<State>())
        {
            foreach (var diff in new[] { Diff.Source, Diff.Server, Diff.Profile, Diff.Root, Diff.Stamp }) rows.Add(diff, state, true);
            // A plain approval after the Seerr or its facts changed.
            rows.Add(Diff.Source, state, false);
            rows.Add(Diff.Stamp, state, false);
        }
        return rows;
    }

    /// <summary>
    /// The request at X, held for a change, then approved choosing the difference's destination (a fresh stamp where the
    /// ids are the same) or as it is. Sent: a keep-getting request whose season 1 went out and whose new season is held.
    /// Unsent: held before anything was sent. Held: held after Seerr stored it without the options (certainty unknown),
    /// then put right in Seerr.
    /// </summary>
    [Theory]
    [MemberData(nameof(ApprovalRows))]
    public async Task AnApprovalReConfirmsOnlyOnTheSameSeerrWithAFreshStampAndNeverMovesWhatWentOut(Diff diff, State state, bool edited)
    {
        using var rig = NewRig();
        string id;
        if (state == State.Sent)
        {
            id = (await rig.Ask(rig.Admin, await At(rig, X, "future", 2))).RequestId!;
            await rig.Outbox.TickAsync(default);
            Assert.Equal("sent", rig.Ledger.Find(id)!.Status);
            Starts(rig, 3);
            Assert.Equal(1, await Follower(rig).FollowSeerrAsync(default));
            Apply(rig, diff == Diff.Source ? Diff.Source : Diff.Stamp);
            await rig.Outbox.TickAsync(default);
        }
        else
        {
            if (state == State.Held) rig.Fake.DropAdvanced = true;
            id = (await rig.Ask(rig.Admin, await At(rig, X, "seasons", 1))).RequestId!;
            if (state == State.Held)
            {
                await rig.Outbox.TickAsync(default);
                Assert.True(Assert.Single(rig.Ledger.ForWant(id)).Uncertain);
                // Someone puts it right in Seerr (the destination chosen).
                var row = rig.Fake.Shows[1731]["mediaInfo"]!["requests"]!.AsArray().Last()!.AsObject();
                (row["serverId"], row["profileId"], row["rootFolder"]) = (X.Server, X.Profile, X.Root);
                rig.Fake.DropAdvanced = false;
            }
            Apply(rig, diff == Diff.Source ? Diff.Source : Diff.Stamp);
            if (state == State.Unsent) await rig.Outbox.TickAsync(default);
        }
        var want = rig.Ledger.Find(id)!;
        Assert.Equal("pending", want.Status);
        var posts = rig.Fake.Posts.Count;
        var target = Y(diff);
        var choice = want.Input with { SeerrServerId = target.Server, SeerrProfileId = target.Profile, SeerrRootFolder = target.Root, SeerrOptions = await rig.Stamp(target.Server, movie: false) };
        var outcome = await rig.Service.ApproveAsync(id, rig.Admin.UserId, edited ? new ApproveRequest(choice) : null, default);

        string expected = (diff, state, edited) switch
        {
            // As it is: the stamp it was made with no longer fits Seerr's facts (another Seerr's stamps differ too).
            (_, _, false) => "seerr_options_changed",
            // The same destination with a fresh stamp, on the same Seerr: re-confirmed, whatever its state.
            (Diff.Stamp, _, true) => "ok",
            // Nothing went out: it may go to the other Seerr, or where the administrator chooses.
            (_, State.Unsent, true) => "ok",
            // Part of it was written: it resumes where it was, never elsewhere.
            (_, State.Held, true) => "request_in_flight",
            // What went out never moves to another Seerr or destination.
            _ => "request_changed",
        };
        if (expected != "ok")
        {
            Assert.Equal((expected, 409), (outcome.Reason, outcome.HttpStatus));
            await rig.Outbox.TickAsync(default);
            Assert.Equal(posts, rig.Fake.Posts.Count);
            Assert.Equal("pending", rig.Ledger.Find(id)!.Status);
            return;
        }
        Assert.True(outcome.HttpStatus == 200, outcome.Reason + ": " + outcome.Message);
        Assert.Equal(choice.SeerrOptions, rig.Ledger.Find(id)!.Input.SeerrOptions);
        if (state == State.Held)
        {
            // Re-confirmed but still uncertain: read back first, never posted again.
            var job = Assert.Single(rig.Ledger.ForWant(id));
            Assert.Equal(("maybe_sent", true, choice.SeerrOptions), (job.State, job.Uncertain, job.Input.SeerrOptions));
            await rig.Outbox.TickAsync(default);
            Assert.Equal(posts, rig.Fake.Posts.Count);
            Assert.Equal(("succeeded", "sent"), (rig.Ledger.Job(job.Id)!.State, rig.Ledger.Find(id)!.Status));
            return;
        }
        await rig.Outbox.TickAsync(default);
        // One new POST, at the destination chosen (on the Seerr asked), with only what hadn't gone out.
        var post = Assert.Single(rig.Fake.Posts.Skip(posts));
        Assert.True(Goes(post.Body, target), post.Body.ToJsonString());
        Assert.Equal(diff == Diff.Source ? "seerr-b.lan" : "seerr.lan", post.Host);
        Assert.Equal(state == State.Sent ? "3" : "1", string.Join(",", post.Body["seasons"]!.AsArray().Select(n => (int)n!)));
        Assert.Equal("sent", rig.Ledger.Find(id)!.Status);
    }

    [Theory]
    [InlineData(State.Sent)]
    [InlineData(State.Unsent)]
    public async Task APlainApprovalAfterTheSeerrChangedNeverSendsWhatWentOutToTheOtherSeerr(State state)
    {
        using var rig = NewRig();
        // A request without options (Seerr picks where), held when Jellyfin Enhanced points at another Seerr.
        string id;
        if (state == State.Sent)
        {
            id = (await rig.Ask(rig.Admin, new MutationInput { Key = Show, Scope = "future", Seasons = new[] { 2 } })).RequestId!;
            await rig.Outbox.TickAsync(default);
            Starts(rig, 3);
            Assert.Equal(1, await Follower(rig).FollowSeerrAsync(default));
        }
        else
        {
            id = (await rig.Ask(rig.Admin, new MutationInput { Key = Show, Scope = "seasons", Seasons = new[] { 1 } })).RequestId!;
        }
        Apply(rig, Diff.Source);
        await rig.Outbox.TickAsync(default);
        Assert.Equal(("pending", "identity_changed"), (rig.Ledger.Find(id)!.Status, rig.Ledger.Find(id)!.Reason));
        var posts = rig.Fake.Posts.Count;
        var outcome = await rig.Service.ApproveAsync(id, rig.Admin.UserId, null, default);
        await rig.Outbox.TickAsync(default);
        if (state == State.Sent)
        {
            // Season 1 went out to the earlier Seerr: it isn't asked for again at this one.
            Assert.Equal(("request_changed", 409), (outcome.Reason, outcome.HttpStatus));
            Assert.Equal(posts, rig.Fake.Posts.Count);
            return;
        }
        // Nothing went out: it goes to the Seerr Jellyfin Enhanced points at now.
        Assert.True(outcome.HttpStatus == 200, outcome.Reason + ": " + outcome.Message);
        Assert.Equal("seerr-b.lan", Assert.Single(rig.Fake.Posts.Skip(posts)).Host);
    }

    // ------------------------------------------------------------------ withdrawing a held request (found live)

    [Theory]
    [InlineData("options changed", "decline")]
    [InlineData("options changed", "cancel")]
    [InlineData("new season held", "decline")]
    [InlineData("new season held", "cancel")]
    [InlineData("Seerr changed", "decline")]
    [InlineData("written, unconfirmed", "decline")]
    public async Task ARequestHeldForItsSeerrChoiceCanBeDeclinedOrCancelledAndWhatWentOutStays(string held, string action)
    {
        using var rig = NewRig();
        string id;
        var follow = held is "new season held" or "Seerr changed";
        if (follow)
        {
            // Season 2 went out; season 3 is held (Seerr's facts changed, or Jellyfin Enhanced points at another Seerr).
            id = (await rig.Ask(rig.Admin, await At(rig, X, "future", 2))).RequestId!;
            await rig.Outbox.TickAsync(default);
            Starts(rig, 3);
            Assert.Equal(1, await Follower(rig).FollowSeerrAsync(default));
            Apply(rig, held == "Seerr changed" ? Diff.Source : Diff.Stamp);
        }
        else
        {
            if (held.StartsWith("written", StringComparison.Ordinal)) rig.Fake.DropAdvanced = true;
            id = (await rig.Ask(rig.Admin, await At(rig, X, "seasons", 1))).RequestId!;
            if (held == "options changed") Apply(rig, Diff.Stamp);
        }
        await rig.Outbox.TickAsync(default);
        Assert.Equal("pending", rig.Ledger.Find(id)!.Status);
        var posts = rig.Fake.Posts.Count;
        var outcome = action == "decline" ? await rig.Service.DeclineAsync(id, rig.Admin.UserId, "Not now.", default) : rig.Service.Close(id, rig.Admin.UserId, null);
        await rig.Outbox.TickAsync(default);
        Assert.Equal(posts, rig.Fake.Posts.Count);
        if (held.StartsWith("written", StringComparison.Ordinal))
        {
            // Seerr may have it: only a read-back (or an OK) settles it, never a withdrawal.
            Assert.Equal(("request_in_flight", 409), (outcome.Reason, outcome.HttpStatus));
            return;
        }
        Assert.True(outcome.HttpStatus == 200, outcome.Reason + ": " + outcome.Message);
        var want = rig.Ledger.Find(id)!;
        if (!follow)
        {
            Assert.Equal(action == "decline" ? "declined" : "cancelled", want.Status);
            Assert.All(rig.Ledger.ForWant(id), j => Assert.Equal("cancelled", j.State));
            return;
        }
        // What went out stays: the request is sent again, without the held season, which isn't followed again.
        Assert.Equal(("sent", "looking"), (want.Status, want.Reason));
        Assert.Equal("succeeded", Assert.Single(rig.Ledger.ForWant(id), j => j.Input.Seasons.SequenceEqual(new[] { 2 })).State);
        Assert.Equal("cancelled", Assert.Single(rig.Ledger.ForWant(id), j => j.Input.Seasons.SequenceEqual(new[] { 3 })).State);
        if (held == "new season held") Assert.Equal(0, await Follower(rig).FollowSeerrAsync(default));
    }

    // ------------------------------------------------------------------ the rule itself, over targets of both backends

    [Theory]
    // Jellyfin Enhanced handling: another connection (a new key) of the same arr is the same place; another arr isn't.
    [InlineData("je", "sent", "new key", "none", null)]
    [InlineData("je", "sent", "other arr", "none", "request_changed")]
    [InlineData("je", "sent", "other arr", "scope", "request_changed")]
    [InlineData("je", "sent", "same", "scope", null)]
    [InlineData("je", "unsent", "other arr", "none", null)]
    // Seerr handling: another Seerr is another place; a fresh stamp re-confirms only on the request's own Seerr.
    [InlineData("seerr", "sent", "other seerr", "none", "request_changed")]
    [InlineData("seerr", "sent", "other seerr", "stamp", "request_changed")]
    [InlineData("seerr", "sent", "same", "stamp", "reconfirms")]
    [InlineData("seerr", "sent", "same", "root", "request_changed")]
    [InlineData("seerr", "held", "same", "stamp", "reconfirms")]
    [InlineData("seerr", "held", "same", "none", null)]
    [InlineData("seerr", "held", "same", "root", "request_in_flight")]
    [InlineData("seerr", "held", "other seerr", "stamp", "request_in_flight")]
    [InlineData("seerr", "held", "other seerr", "none", "request_in_flight")]
    [InlineData("seerr", "unsent", "other seerr", "stamp", null)]
    [InlineData("seerr", "unsent", "same", "root", null)]
    [InlineData("seerr", "unsent", "same", "stamp", "reconfirms")]
    public void TheReconfirmationRuleOverEveryTargetAndChange(string backend, string state, string target, string change, string? expected)
    {
        var plain = new MutationInput { Key = Show, Scope = "seasons", Seasons = new[] { 1 } };
        var original = backend == "je" ? plain : plain with { SeerrServerId = 0, SeerrProfileId = 4, SeerrRootFolder = "/tv", SeerrOptions = "STAMP0" };
        var approved = change switch
        {
            "stamp" => original with { SeerrOptions = "STAMP1" },
            "root" => original with { SeerrRootFolder = "/tv-anime", SeerrOptions = "STAMP1" },
            "scope" => original with { Seasons = new[] { 1, 2 } },
            _ => original,
        };
        RequestAuthorization Auth(string instance, string generation, string? source)
            => new(Guid.Empty, null, "request", "seasons", "standard", backend, instance, generation, "r", source);
        var here = backend == "je" ? Auth("sonarr-a", "g1", null) : Auth(string.Empty, string.Empty, "seerr-a");
        var there = (backend, target) switch
        {
            ("je", "new key") => Auth("sonarr-a", "g2", null),
            ("je", "other arr") => Auth("sonarr-b", "g1", null),
            (_, "other seerr") => Auth(string.Empty, string.Empty, "seerr-b"),
            _ => here,
        };
        var job = new RequestJob("j", "w", original, here, state switch { "sent" => "succeeded", "held" => "parked", _ => "queued" }, 1, DateTimeOffset.UnixEpoch, "x", "k", original.Fingerprint, Uncertain: state == "held");
        var verdict = RequestDestination.Approval(original, RequestLedger.TargetKey(here), approved, RequestLedger.TargetKey(there), change != "none", new[] { job }, resumeHeld: true);
        Assert.Equal(expected == "reconfirms" ? (null, true) : (expected, false), (verdict.Refusal, verdict.Reconfirms));
        // An approver's matching ask never resumes a written part.
        if (state == "held") Assert.Equal("request_in_flight", RequestDestination.Approval(original, RequestLedger.TargetKey(here), approved, RequestLedger.TargetKey(there), change != "none", new[] { job }, resumeHeld: false).Refusal);
    }

    // ------------------------------------------------------------------ the source: no path compares requests by itself

    // The comparisons and selections on where a request goes or what it asks for that may be made outside the rule, each
    // with why, and (when it picks from a collection) the local that must have been built through the rule. An entry that
    // no longer matches fails too. File, member (Type.Member), code (whitespace normalised, contained), why, requires.
    private static readonly (string File, string Member, string Code, string Why, (string Local, string Rule)? Requires)[] Allowed =
    {
        ("RequestLedger.cs", "RequestLedger.ExtendSchemaTwo", "j.Authorization.InstanceId == want.Input.InstanceId",
            "the v2 migration works out which target a legacy request's own jobs went to; coverage after it uses Extra", null),
        ("RequestLedger.cs", "RequestLedger.ExtendSchemaTwo", "== row.Episodes",
            "the v2 migration matches a legacy reservation to its own request's job by size", null),
        ("RequestLedger.cs", "RequestLedger.OverSeries", ".SelectMany(w => w.Input.SeasonNumbers)",
            "a Member's series threshold counts every season the person asked for, wherever it went (Members choose no destination)", null),
        ("RequestLedger.cs", "RequestLedger.OverSeries", ".Count() > Math.Clamp(threshold, 1, 200)", "the series threshold: the same count", null),
        ("RequestLedger.cs", "RequestLedger.EstimateGb", "RequestSizeHint.Estimate(input, facts.Size)", "an estimate from the instance's typical sizes, not another request", null),
        ("RequestLedger.cs", "RequestLedger.CreateCore", "w.Input.Overlaps(normalized)",
            "the dedup representative is chosen only among the person's requests that serve the ask", ("ownSame", "Serves")),
        ("RequestLedger.cs", "RequestLedger.SplitAtThreshold", ".SelectMany(w => w.Input.SeasonNumbers)", "the series-threshold split: the same count as the threshold", null),
        ("RequestLedger.cs", "RequestLedger.SplitAtThreshold", "asked.Contains(s)", "the series-threshold split: the seasons the person asked for", null),
        ("RequestLedger.cs", "RequestLedger.SplitAtThreshold", "room >= fresh.Length", "the series-threshold split: the room under the threshold", null),
        ("RequestLedger.cs", "RequestLedger.SplitAtThreshold", "first.Contains", "the series-threshold split: the part that goes ahead", null),
        ("RequestLedger.cs", "RequestLedger.SplitAtThreshold", "held.Contains", "the series-threshold split: the part that waits", null),
        ("RequestLedger.cs", "RequestLedger.HeldFollows", "j.Input.Seasons.Intersect(want.Input.Seasons)", "one request's own jobs (its followed new seasons)", null),
        ("RequestLedger.cs", "RequestLedger.HeldFollows", ".SelectMany(j => j.Input.Seasons)", "one request's own jobs (its followed new seasons)", null),
        ("RequestLedger.cs", "RequestLedger.HeldFollows", "going.Contains", "one request's own jobs (its followed new seasons)", null),
        ("RequestLedger.cs", "RequestLedger.ChargeFutureSeason", "want.Input.Seasons.Contains(season)", "the season asked about against the request's own scope", null),
        ("RequestLedger.cs", "RequestLedger.FollowFutureSeason", "want.Input.Seasons.Contains(season)", "the season asked about against the request's own scope", null),
        ("RequestLedger.cs", "RequestLedger.FollowFutureSeason", "j.Input.Seasons.Contains(season)", "one request's own jobs: a new season once per request", null),
        ("FutureSeasonCharges.cs", "FutureSeasonCharges.Charge", "s.SeasonNumber > current", "Sonarr's seasons after the request's own current one", null),
        ("FutureSeasonCharges.cs", "FutureSeasonCharges.FollowSeerrAsyncFactsCore", "n > current", "Seerr's seasons after the request's own current one", null),
        ("FutureSeasonCharges.cs", "FutureSeasonCharges.Charge", ".Bump(new[] { want.Input.Key,", "tells the title's watchers (the change feed is keyed by title), not another request", null),
        ("FutureSeasonCharges.cs", "FutureSeasonCharges.FollowSeerrAsyncFactsCore", ".Bump(new[] { want.Input.Key,", "tells the title's watchers (the change feed is keyed by title), not another request", null),
        ("FutureSeasonCharges.cs", "FutureSeasonCharges.Find", "library.SeriesByTvdb(id)", "finds the series in Sonarr's library by the title's ids, not another request", null),
        ("FutureSeasonCharges.cs", "FutureSeasonCharges.Find", "library.SeriesByTmdb(id)", "finds the series in Sonarr's library by the title's ids, not another request", null),
        ("RequestLedgerTitles.cs", "RequestLedger.Canonical", "key == input.Key", "the identity resolver itself: whether resolving the key changed it", null),
    };

    // Every path where one request stands for, covers, dedups, suppresses, merges with, follows or represents another, and
    // the calls to the rule it makes (at least these: taking one out fails, adding one doesn't).
    private static readonly Dictionary<string, (string[] Calls, string Path)> Paths = new()
    {
        ["RequestLedger.ExtendSchemaTwo"] = (new[] { "Extra", "SameEdition", "SameTarget" }, "the v2 target migration's coverage"),
        ["RequestLedger.OverSeries"] = (new[] { "SameTitle" }, "a Member's seasons of the title"),
        ["RequestLedger.SplitAtThreshold"] = (new[] { "SameTitle" }, "the series-threshold split: the person's seasons of the title"),
        ["RequestLedger.FollowWithin"] = (new[] { "Extra", "Extra", "Extra" }, "a merged title: who already covers whom"),
        ["FutureSeasonCharges.FollowSeerrAsyncFactsCore"] = (new[] { "Edition" }, "keep-getting requests grouped by title and edition"),
        ["RequestLedger.HoldWithout4k"] = (new[] { "Extra", "Extra" }, "a 4K request released: sent or queued by what covers it"),
        ["RequestLedger.SentCovers"] = (new[] { "Extra", "SamePlace" }, "family Search: what went out covers the ask"),
        // CheckTitleChoice no longer grants a same-admin scope correction: replacing an owned
        // choice requires the submitted revision, irrespective of overlap. Its admission/approval
        // authorization is protected by TitleChoiceRegistryArchitectureTests instead.
        ["RequestLedger.TitleChoiceJobs"] = (new[] { "SameTarget" }, "title-wide immutability fences stay within the request destination"),
        ["RequestLedger.ChoiceDiffers"] = (new[] { "ArrChoicesDiffer" }, "title-choice edits use the common destination comparison without owning their values"),
        ["RequestLedger.RoutingChanged"] = (new[] { "RoutingChanged" }, "an approval changes routing (administrators only)"),
        ["RequestLedger.CreateCore"] = (new[] { "Extra", "Extra", "Extra", "Extra", "Extra", "Extra", "Extra", "SameEdition", "SameTarget", "Serves", "SameInstance", "SameInput" },
            "own dedup and its representative, implicit approval, decline cooldown, shared coverage, confirmed scope"),
        ["RequestLedger.Coverage"] = (new[] { "SameTarget", "SameTarget" }, "shared coverage at a target"),
        ["RequestLedger.Confirmed"] = (new[] { "SameTarget" }, "what went out to a target"),
        ["RequestLedger.ConfirmedScope"] = (new[] { "Extra" }, "an ask already sent"),
        ["RequestLedger.ApproveCore"] = (new[] { "Approval", "Extra", "SameEdition", "SameOptions", "SameTarget", "SameTarget", "SameTarget", "SameTitle", "SameInput", "SameInput" }, "the re-confirmation rule, re-stamped jobs, approved coverage, an edit naming its own title"),
        ["RequestLedger.RehomeFollowers"] = (new[] { "Extra", "Extra", "SameTarget", "SameTarget" }, "followers moved with a request's target"),
        ["RequestLedger.DemoteUncoveredFollowers"] = (new[] { "Extra", "SameTarget" }, "followers left without coverage wait"),
        ["RequestLedger.ReleasePendingFollowers"] = (new[] { "Extra", "Extra" }, "waiting followers released by coverage"),
        ["RequestLedger.Withdraw"] = (new[] { "Extra" }, "withdrawal: who sees it where it goes; what went out covers it"),
        ["RequestLedger.RestorePendingOwners"] = (new[] { "Extra" }, "a decline's followers own what nothing covers"),
        ["RequestLedger.WithdrawFollowers"] = (new[] { "Extra", "Extra" }, "a cancel's followers withdrawn"),
        ["RequestLedger.FollowFutureSeason"] = (new[] { "SameTarget" }, "a new season followed on the request's own Seerr"),
        ["RequestLedger.Complete"] = (new[] { "Extra", "Extra", "Extra", "Extra", "SameTarget" }, "shared dispatch: who a send serves"),
        ["RequestLedger.Renumber"] = (new[] { "SameTarget", "SameTarget", "WithoutMatches", "SameTarget", "Renumbered", "Moves", "Renumbered", "Renumbered", "Moves" }, "F83: each TMDB-numbered (or switched) ask takes Sonarr's numbers on its own once every episode is matched by id, checked against the target's last read; a lost match takes the coverage derived from it"),
        ["RequestLedger.Reresolve"] = (new[] { "Only" }, "F83: a request whose match was lost asks again for the lost episodes only"),
        ["RequestLedger.EnsureEpisodeIdentities"] = (new[] { "SameTarget", "NamesAny" }, "F83: matches kept without a TVDB id: requests at that target naming those episodes are matched again"),
        ["RequestLedger.LeadsRetryCycle"] = (new[] { "Extra", "Extra", "Serves", "Serves" }, "retry wait cycles include only work at the same title, edition and destination"),
        ["RequestLedger.Redundancy"] = (new[] { "Extra", "Extra", "Extra", "Extra", "Serves", "Serves" }, "the send-time check: what went out (or is going out) for the title is never sent again"),
        ["RequestLedger.PurgeUser"] = (new[] { "Extra", "SameTarget" }, "a deleted person's requests kept while others follow them"),
        ["RequestLedger.ImportSeerr"] = (new[] { "Extra", "SameTarget", "SameTarget" }, "the Seerr import's dedup"),
        ["FutureSeasonCharges.Explicit"] = (new[] { "SameTarget" }, "the requests that suppress a follow"),
        ["FutureSeasonCharges.AskedFor"] = (new[] { "Extra" }, "a new season already asked for at the destination"),
    };

    // Where the title identity itself is worked out: these look titles up by each alias on purpose.
    private static readonly HashSet<string> IdentityMembers = new(StringComparer.Ordinal) { "RequestLedger.Needed", "RequestLedger.UnifyCore", "RequestLedger.IsRetainedIdentity" };

    // The rule file a listed path is in.
    private static string FileOf(string member) => member switch
    {
        "RequestLedger.ImportSeerr" => "RequestLedgerImport.cs",
        "RequestLedger.FollowWithin" or "RequestLedger.UnifyCore" or "RequestLedger.Needed" or "RequestLedger.IsRetainedIdentity" => "RequestLedgerTitles.cs",
        _ when member.StartsWith("FutureSeasonCharges.", StringComparison.Ordinal) => "FutureSeasonCharges.cs",
        _ => "RequestLedger.cs",
    };

    // What the walk says is wrong with a plugin: comparisons outside the rule not allowed here, paths that lost a call to
    // the rule, Extra or Seerr's record check not through it. (Stale allowances are checked by the source test only.)
    private static List<string> Problems(DestinationRuleWalk walk, params string[] files) => Problems(walk, null, files);

    // The same for one member of one file (what a mutation there can change).
    private static List<string> Problems(DestinationRuleWalk walk, string? member, params string[] files)
    {
        var problems = new List<string>();
        foreach (var site in walk.Raw(member, files))
        {
            var allowed = Allowed.Where(a => a.File == site.File && a.Member == site.Member && site.Code.Contains(a.Code, StringComparison.Ordinal)).ToList();
            if (allowed.Count == 0) problems.Add("not through RequestDestination: " + site);
            foreach (var a in allowed.Where(a => a.Requires is { } r && !walk.BuiltThrough(a.File, a.Member, r.Local, r.Rule)))
                problems.Add($"selects from {a.Requires!.Value.Local}, not built through RequestDestination.{a.Requires.Value.Rule} ({a.Why}): {site}");
        }
        var calls = walk.RuleCalls(member, files);
        foreach (var (listed, (expected, path)) in Paths)
        {
            if ((files.Length > 0 && !files.Contains(FileOf(listed))) || (member != null && listed != member)) continue;
            var actual = calls.GetValueOrDefault(listed) ?? new List<string>();
            var missing = expected.ToList();
            foreach (var call in actual) missing.Remove(call);
            if (missing.Count > 0) problems.Add($"{listed} ({path}) no longer calls RequestDestination/Extra: missing {string.Join(", ", missing)} (has {string.Join(", ", actual)})");
        }
        // Every lookup of a title by key resolves its aliases (RequestLedger.TitleIs), except where the identity itself is
        // worked out.
        foreach (var lookup in walk.RawTitleLookups(files).Where(l => (member == null || l.Member == member) && !IdentityMembers.Contains(l.Member)))
            problems.Add($"looks a title up by a key as given (not RequestLedger.TitleIs): {lookup.File} {lookup.Member}: {lookup.Sql}");
        if (walk.ExtraProblem() is { } extra) problems.Add("MutationInput.Extra: " + extra);
        if (!walk.SeerrRecordThroughTheRule()) problems.Add("SeerrBackend.SameOptions doesn't delegate to RequestDestination.SeerrHas");
        return problems;
    }

    /// <summary>
    /// The source test over the walk (<see cref="DestinationRuleWalk"/>). Defence in depth (D41's principle): it catches the
    /// cheap, likely ways around the rule, but a static walk over arbitrary C# can't be complete; the guarantee is
    /// <c>RequestDestination.Serves</c> on every path, proven by the runtime rows of this table and the withdrawal, sight and
    /// identity tables.
    /// </summary>
    [Fact]
    public void EveryLedgerAndChargesPathComparesOrSelectsRequestsThroughTheDestinationRule()
    {
        var walk = DestinationRuleWalk.Plugin;
        // Symbols are only followed reliably in code that compiles.
        Assert.Empty(walk.Errors());
        // Every part of the ledger is read (a new partial file is too).
        Assert.Equal(DestinationRuleWalk.RuleFiles.Where(f => f.StartsWith("RequestLedger", StringComparison.Ordinal)).Order(StringComparer.Ordinal),
            Directory.GetFiles(Path.Combine(DestinationRuleWalk.Root(), "Jellyfin.Plugin.JellyfinEnhanced", "Services", "Acquire", "Requests"), "RequestLedger*.cs").Select(Path.GetFileName).Order(StringComparer.Ordinal));
        var problems = Problems(walk);
        Assert.True(problems.Count == 0, "Requests compared or selected without RequestDestination:\n" + string.Join("\n", problems));
        var sites = walk.Raw();
        var stale = Allowed.Where(a => !sites.Any(s => s.File == a.File && s.Member == a.Member && s.Code.Contains(a.Code, StringComparison.Ordinal))).Select(a => a.Member + ": " + a.Code).ToList();
        Assert.True(stale.Count == 0, "Allowed comparisons no longer found:\n" + string.Join("\n", stale));
        // Every call to the rule in these files belongs to a path listed here.
        var unlisted = walk.RuleCalls().Keys.Where(m => !Paths.ContainsKey(m)).ToList();
        Assert.True(unlisted.Count == 0, "Paths calling RequestDestination that aren't listed: " + string.Join(", ", unlisted));
        // The input type has no destination comparison of its own.
        Assert.DoesNotContain(typeof(MutationInput).GetMethods(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic),
            m => m.Name.Contains("Destination", StringComparison.Ordinal) || m.Name.Contains("SameOptions", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("ProfileId")]
    [InlineData("RootFolder")]
    public void RegistryRoutingFieldsStillRequireTheDestinationRule(string field)
    {
        var mutant = DestinationRuleWalk.Plugin.With("Services/Acquire/Requests/RequestLedger.cs", source => source.Replace(
            "var conflict = TitleChoiceRegistry.Conflicts(current, input);",
            $"if (current.{field} != input.{field}) return null;\n var conflict = TitleChoiceRegistry.Conflicts(current, input);", StringComparison.Ordinal));
        Assert.Empty(mutant.Errors("Services/Acquire/Requests/RequestLedger.cs"));
        Assert.Contains(Problems(mutant, "RequestLedger.CheckTitleChoice", "RequestLedger.cs"),
            p => p.StartsWith("not through RequestDestination:", StringComparison.Ordinal));
    }

    /// <summary>Each call to the rule in the ledger and charges files, as a mutation: taken out (A) or done by a raw comparison (B).</summary>
    public static TheoryData<string, int> RuleMutations()
    {
        var rows = new TheoryData<string, int>();
        var sites = DestinationRuleWalk.Plugin.RuleSites();
        for (var i = 0; i < sites.Count; i++)
        {
            rows.Add("A", i);
            if (sites[i].Raw != null) rows.Add("B", i);
        }
        return rows;
    }

    /// <summary>
    /// Mutation checks (security-r4-2): taking the destination filtering out of each protected path, or doing it by a raw
    /// comparison instead, is reported by the guard, for the path it was taken from. Each mutant still compiles.
    /// </summary>
    [Theory]
    [MemberData(nameof(RuleMutations))]
    public void TakingTheRuleOutOfAnyPathIsReported(string kind, int index)
    {
        var site = DestinationRuleWalk.Plugin.RuleSites()[index];
        var code = kind == "A" ? site.Without : site.Raw!;
        var mutant = DestinationRuleWalk.Plugin.Replace(site, code);
        var label = $"{kind} {site.File}:{site.Line} {site.Member}: {site.Code} → {code}";
        var errors = mutant.Errors("Services/Acquire/Requests/" + site.File, site.Span.Start);
        Assert.True(errors.Count == 0, label + " doesn't compile:\n" + string.Join("\n", errors));
        var problems = Problems(mutant, site.Member, site.File);
        Assert.True(problems.Any(p => p.Contains(site.Member, StringComparison.Ordinal)), label + " wasn't reported:\n" + string.Join("\n", problems));
        // A raw comparison is found by itself, not only by the path losing its call.
        if (kind == "B") Assert.True(problems.Any(p => p.StartsWith("not through RequestDestination: " + site.File, StringComparison.Ordinal) && p.Contains(site.Member, StringComparison.Ordinal)), label + ": the raw comparison wasn't found:\n" + string.Join("\n", problems));
    }

    /// <summary>Bypasses planted the ways the review found and the ways a helper or a collection operation could hide one.</summary>
    [Theory]
    // Review round 4: AskedFor through Array.IndexOf over each request's seasons.
    [InlineData("an Array.IndexOf over each request's seasons")]
    // A plugin helper that compares seasons (MutationInput.Overlaps).
    [InlineData("a plugin helper (Overlaps)")]
    [InlineData("ASCII grammar comparing two request keys")]
    // A new helper in another file that compares what it is given.
    [InlineData("a new helper in another file")]
    // The seasons merged into a set first, then looked up.
    [InlineData("a set built from the requests' seasons")]
    // The targets merged into a set first, then looked up.
    [InlineData("a set built from the requests' targets")]
    // Requests grouped by target.
    [InlineData("requests grouped by their target")]
    // A target compared through a local and string.Equals.
    [InlineData("a target compared through a local")]
    // Extra without asking the rule.
    [InlineData("Extra without RequestDestination.Serves")]
    // Seerr's record matched by hand.
    [InlineData("Seerr's record matched by hand")]
    // Q-4BFIX3-2: the decline cooldown comparing raw keys.
    [InlineData("the decline cooldown comparing raw keys")]
    // Q-4BFIX3-2: shared coverage looked up by the key as given.
    [InlineData("shared coverage looked up by the key as given")]
    // Q-4BFIX3-2: keep-getting requests grouped by raw key.
    [InlineData("keep-getting requests grouped by raw key")]
    // Review round 5 (security-r5-2): two requests held in one array, compared element by element.
    [InlineData("two requests held in one array")]
    // The same with the first and last of one list.
    [InlineData("the first and last of one list")]
    public void BypassesThroughHelpersAndCollectionOperationsAreReported(string bypass)
    {
        var plugin = DestinationRuleWalk.Plugin;
        const string asked = "=> want.Input.NewSeason(season).Extra(asked) == null;";
        const string explicitFilter = "RequestDestination.SameTarget(w.TargetKey, want.TargetKey)";
        DestinationRuleWalk Charges(string from, string to) => plugin.With("Services/Acquire/Requests/FutureSeasonCharges.cs", text => text.Replace(from, to, StringComparison.Ordinal));
        var mutant = bypass switch
        {
            "an Array.IndexOf over each request's seasons" => Charges(asked, "=> asked.Any(i => Array.IndexOf(i.Seasons, season) >= 0);"),
            "a plugin helper (Overlaps)" => Charges(asked, "=> asked.Any(i => i.Overlaps(want.Input.NewSeason(season)));"),
            "ASCII grammar comparing two request keys" => Charges(explicitFilter, "Jellyfin.Plugin.JellyfinEnhanced.Helpers.AsciiGrammar.StartsWithIgnoreCase(w.Input.Key, want.Input.Key)"),
            "a new helper in another file" => plugin
                .With("Services/Acquire/BridgePaths.cs", text => text.Replace("    public static class BridgePaths\n    {", "    public static class BridgePaths\n    {\n        internal static bool HasSeason(Requests.MutationInput input, int season) => System.Array.IndexOf(input.Seasons, season) >= 0;\n", StringComparison.Ordinal))
                .With("Services/Acquire/Requests/FutureSeasonCharges.cs", text => text.Replace(asked, "=> asked.Any(i => BridgePaths.HasSeason(i, season));", StringComparison.Ordinal)),
            "a set built from the requests' seasons" => Charges(asked, "=> asked.SelectMany(i => i.Seasons).ToHashSet().Contains(season);"),
            "a set built from the requests' targets" => Charges(explicitFilter, "others.Select(o => o.TargetKey).ToHashSet().Contains(want.TargetKey)"),
            "requests grouped by their target" => Charges(explicitFilter, "others.GroupBy(o => o.TargetKey).Count() == 1"),
            "a target compared through a local" => Charges(explicitFilter, "string.Equals(w.TargetKey, want.TargetKey, StringComparison.Ordinal)"),
            "Extra without RequestDestination.Serves" => plugin.With("Services/Acquire/Requests/RequestModels.cs", text => text.Replace("covered.Where(c => RequestDestination.Serves(this, c)).ToArray()", "covered.ToArray()", StringComparison.Ordinal)),
            "the decline cooldown comparing raw keys" => plugin.With("Services/Acquire/Requests/RequestLedger.cs", text => text.Replace("w.Status == \"declined\" && RequestDestination.SameEdition(w.Input, normalized)", "w.Status == \"declined\" && w.Input.Key == normalized.Key && w.Input.Variant == normalized.Variant", StringComparison.Ordinal)),
            "shared coverage looked up by the key as given" => plugin.With("Services/Acquire/Requests/RequestLedger.cs", text => text.Replace("var covered = Wants(c, t, TitleIs + \" AND variant=$v\", (\"$key\", normalized.Key)", "var covered = Wants(c, t, \"title_key=$key AND variant=$v\", (\"$key\", normalized.Key)", StringComparison.Ordinal)),
            "keep-getting requests grouped by raw key" => Charges("GroupBy(w => RequestDestination.Edition(w.Input))", "GroupBy(w => (w.Input.Key, w.Input.Variant))"),
            "two requests held in one array" => Charges(asked, "{ var pair = new[] { want.Input.NewSeason(season), asked.FirstOrDefault() }; return pair[0].Extra(asked) == null || pair[1] != null && pair[0].Seasons.Intersect(pair[1].Seasons).Any(); }"),
            "the first and last of one list" => Charges(asked, "{ var list = asked.Prepend(want.Input.NewSeason(season)).ToList(); return list.First().Extra(asked) == null || list.Count > 1 && list.First().Seasons.Intersect(list.Last().Seasons).Any(); }"),
            _ => plugin.With("Services/Acquire/Requests/SeerrBackend.cs", text => text.Replace("=> RequestDestination.SeerrHas(", "=> SeerrHasByHand(", StringComparison.Ordinal)
                .Replace("        // ---------------- transport ----------------", "        private static bool SeerrHasByHand(MutationInput input, int? server, int? profile, string? root) => server == input.SeerrServerId && profile == input.SeerrProfileId && root == input.SeerrRootFolder;\n\n        // ---------------- transport ----------------", StringComparison.Ordinal)),
        };
        var errors = mutant.Errors();
        Assert.True(errors.Count == 0, string.Join("\n", errors));
        var problems = Problems(mutant);
        Assert.NotEmpty(problems);
        // The bypass in the charges file is found as a raw comparison there, not only as a path that lost its call.
        if (bypass is not ("Extra without RequestDestination.Serves" or "Seerr's record matched by hand" or "the decline cooldown comparing raw keys" or "shared coverage looked up by the key as given"))
            Assert.Contains(problems, p => p.StartsWith("not through RequestDestination: FutureSeasonCharges.cs", StringComparison.Ordinal));
        if (bypass == "the decline cooldown comparing raw keys") Assert.Contains(problems, p => p.StartsWith("not through RequestDestination: RequestLedger.cs", StringComparison.Ordinal) && p.Contains("CreateCore", StringComparison.Ordinal));
        if (bypass == "shared coverage looked up by the key as given") Assert.Contains(problems, p => p.StartsWith("looks a title up by a key as given", StringComparison.Ordinal) && p.Contains("CreateCore", StringComparison.Ordinal));
    }
}
