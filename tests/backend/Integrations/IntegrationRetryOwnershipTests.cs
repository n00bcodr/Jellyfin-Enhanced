using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using L = JE.Tests.IntegrationRequestLedgerTests;

namespace JE.Tests;

/// <summary>Public retry ownership survives preparation, transport, restart, restore and the terminal replay deadline.</summary>
[Collection("Plugin singleton")]
public class IntegrationRetryOwnershipTests
{
    private static ArrActionRequest Action(Guid user, string key, Func<CancellationToken, Task<ArrError?>> send, string target = "movie:603") => new()
    { UserId = user, IdempotencyKey = key, Action = "movie.search", InstanceId = "r1", Target = target, Execute = send };

    [Fact]
    public async Task ACompletedActionReopensWithItsOriginalReceiptAndNoSecondSend()
    {
        using var r = new L.Rig();
        var sends = 0;
        Task<ArrError?> Send(CancellationToken _) { sends++; return Task.FromResult<ArrError?>(null); }
        var first = await new ArrActionRunner(r.Audit, new ArrConfirmationTokens()).RunAsync(Action(r.Admin, "receipt", Send));
        r.Reopen();
        var replay = await new ArrActionRunner(r.Audit, new ArrConfirmationTokens()).RunAsync(Action(r.Admin, "receipt", Send));
        Assert.True(replay.Replayed);
        Assert.Equal(first.AuditId, replay.AuditId);
        Assert.Equal(1, sends);
        Assert.Equal(PressChecks.Conflict, (await r.Create(r.Admin, client: "receipt")).Reason);
    }

    [Theory]
    [InlineData("reserved")]
    [InlineData("sending")]
    [InlineData("unknown")]
    public async Task AnInterruptedOwnerRestoresUnresolvedAndCannotBecomeAnotherAction(string stage)
    {
        using var r = new L.Rig();
        var runner = new ArrActionRunner(r.Audit, new ArrConfirmationTokens());
        byte[]? snapshot = null;
        if (stage == "reserved")
        {
            r.Policy.Before = (_, _) => { snapshot = r.Db.Snapshot(); return Task.CompletedTask; };
            await r.Create(r.Admin, client: "interrupted");
        }
        else
        {
            await runner.RunAsync(Action(r.Admin, "interrupted", _ =>
            {
                if (stage == "sending") snapshot = r.Db.Snapshot();
                return Task.FromResult<ArrError?>(stage == "unknown" ? new ArrError(ArrErrorKind.Timeout, "uncertain") : null);
            }));
            if (stage == "unknown") snapshot = r.Db.Snapshot();
        }
        Assert.NotNull(snapshot);
        r.Db.ReplaceWith(snapshot!);
        r.Reopen();
        var sends = 0;
        var restarted = new ArrActionRunner(r.Audit, new ArrConfirmationTokens());
        var result = await restarted.RunAsync(Action(r.Admin, "interrupted", _ => { sends++; return Task.FromResult<ArrError?>(null); }));
        if (stage == "reserved") Assert.True(result.Conflict);
        else Assert.Equal(ArrActionStatus.Unknown, result.Status);
        Assert.Equal(0, sends);
        var ask = await r.Create(r.Admin, client: "interrupted");
        Assert.Equal(stage == "reserved" ? "request_in_flight" : PressChecks.Conflict, ask.Reason);
        Assert.Empty(r.Ledger.ForTitle(L.Movie().Key));
    }

    [Fact]
    public async Task ActiveOwnershipDoesNotExpireWhileItsSendIsStillRunning()
    {
        using var r = new L.Rig();
        var runner = new ArrActionRunner(r.Audit, new ArrConfirmationTokens(), () => r.Now);
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = runner.RunAsync(Action(r.Admin, "active", async _ => { reached.SetResult(); await release.Task; return null; }));
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        r.Now = r.Now.AddDays(1);
        var sends = 0;
        try
        {
            var other = await runner.RunAsync(Action(r.Admin, "active", _ => { sends++; return Task.FromResult<ArrError?>(null); }, "movie:604"));
            Assert.True(other.Conflict);
            Assert.Equal(0, sends);
        }
        finally { release.SetResult(); }
        Assert.Equal(ArrActionStatus.Succeeded, (await first).Status);
    }

    [Fact]
    public async Task ADirectRunnerCannotBypassAnExistingPreparationOwner()
    {
        using var r = new L.Rig();
        var runner = new ArrActionRunner(r.Audit, new ArrConfirmationTokens());
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = runner.SingleFlightAsync(r.Admin, "preparing", "first-request", async _ =>
        { reached.SetResult(); await release.Task; return new ArrActionOutcome { Status = ArrActionStatus.Rejected }; },
            () => new ArrActionOutcome { Conflict = true }, default);
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var sends = 0;
        try
        {
            var direct = await runner.RunAsync(Action(r.Admin, "preparing", _ => { sends++; return Task.FromResult<ArrError?>(null); }));
            Assert.True(direct.Conflict);
            Assert.Equal(0, sends);
        }
        finally { release.SetResult(); }
        await first;
    }

    [Fact]
    public async Task ACancelledWaiterCannotReleaseTheOwnersReservationOrEffects()
    {
        using var r = new L.Rig();
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        r.Policy.Before = async (_, _) => { reached.TrySetResult(); await release.Task; };
        var first = r.Create(r.Admin, client: "waiter");
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        using var gone = new CancellationTokenSource();
        var waiter = r.Service.CreateAsync(r.Admin, new CreateRequest("waiter", L.Movie()), gone.Token);
        gone.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiter);
        var runner = new ArrActionRunner(r.Audit, new ArrConfirmationTokens());
        try { Assert.True((await runner.RunAsync(Action(r.Admin, "waiter", _ => Task.FromResult<ArrError?>(null)))).Conflict); }
        finally { release.SetResult(); }
        Assert.Equal(201, (await first).HttpStatus);
        Assert.Single(r.Ledger.ForTitle(L.Movie().Key));
        Assert.Equal(1, r.Service.Quota(r.Admin).Used);
    }

    [Fact]
    public async Task AFailedReservationSendsNothing()
    {
        using var r = new L.Rig();
        Assert.True(r.Db.Available);
        r.Db.Write((c,t) => { using var cmd = c.CreateCommand(); cmd.Transaction = t; cmd.CommandText = "CREATE TRIGGER stop_retry BEFORE INSERT ON retry_owners BEGIN SELECT RAISE(ABORT, 'write unavailable'); END"; return cmd.ExecuteNonQuery(); });
        var sends = 0;
        await Assert.ThrowsAsync<Microsoft.Data.Sqlite.SqliteException>(() => new ArrActionRunner(r.Audit, new ArrConfirmationTokens()).RunAsync(Action(r.Admin, "no-database", _ => { sends++; return Task.FromResult<ArrError?>(null); })));
        Assert.Equal(0, sends);
    }
    [Fact]
    public async Task FailedReceiptPersistenceRetainsUncertaintyAcrossRestart()
    {
        using var r = new L.Rig();
        Assert.True(r.Db.Available);
        r.Db.Write((c,t) => { using var cmd = c.CreateCommand(); cmd.Transaction = t; cmd.CommandText = "CREATE TRIGGER stop_outcome BEFORE UPDATE ON retry_owners WHEN NEW.action_receipt IS NOT NULL BEGIN SELECT RAISE(ABORT, 'write unavailable'); END"; return cmd.ExecuteNonQuery(); });
        var sends = 0;
        Task<ArrError?> Send(CancellationToken _) { sends++; return Task.FromResult<ArrError?>(null); }
        var first = await new ArrActionRunner(r.Audit, new ArrConfirmationTokens()).RunAsync(Action(r.Admin, "uncertain-result", Send));
        Assert.Equal(ArrActionStatus.Unknown, first.Status);
        r.Reopen();
        var again = await new ArrActionRunner(r.Audit, new ArrConfirmationTokens()).RunAsync(Action(r.Admin, "uncertain-result", Send));
        Assert.Equal(ArrActionStatus.Unknown, again.Status); Assert.Equal(1, sends);
    }

    [Fact]
    public async Task SearchSlotClaimsSurviveAServiceRestartAndOnlyTheUnclaimedRemainderRuns()
    {
        using var p = new IntegrationEditionPressTests.PressRig(false);
        var (intent, _) = await IntegrationEditionPressIdentityTests.FiftyOneMissing(p);
        Assert.Equal("searched", (await p.Search.SearchAsync(p.Rig.Member, "tv:tvdb:78874:s1", "first-parts", default, intent)).Outcome.Reason);
        var restarted = new RequestSearchService(p.Requests, p.Manage, () => p.Rig.Arr.Now);
        Assert.Equal("searched", (await restarted.SearchAsync(p.Rig.Member, "tv:tvdb:78874:s1", "remaining-parts", default, intent)).Outcome.Reason);
        var commands = p.Rig.Sonarr.Writes.Where(w => w.Path == "/api/v3/command").ToArray();
        Assert.Equal(2, commands.Length);
        Assert.Single(System.Text.Json.Nodes.JsonNode.Parse(commands[1].Body)!["episodeIds"]!.AsArray());
    }

    [Fact]
    public async Task TheTerminalDeadlineSurvivesReopenAndAnExpiredCompletedActionCanBeReplaced()
    {
        using var r = new L.Rig();
        var runner = new ArrActionRunner(r.Audit, new ArrConfirmationTokens(), () => r.Now);
        Assert.Equal(ArrActionStatus.Succeeded, (await runner.RunAsync(Action(r.Admin, "deadline", _ => Task.FromResult<ArrError?>(null)))).Status);
        r.Reopen();
        Assert.Equal(PressChecks.Conflict, (await r.Create(r.Admin, client: "deadline")).Reason);
        r.Now = r.Now.AddMinutes(11);
        Assert.Equal(201, (await r.Create(r.Admin, client: "deadline")).HttpStatus);
    }

    [Fact]
    public async Task APreparingActionCannotSendAfterTheSharedDatabaseWasRestored()
    {
        using var r = new L.Rig();
        var runner = new ArrActionRunner(r.Audit, new ArrConfirmationTokens());
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var identity = ArrActionRunner.Identity("movie.search", "r1", "movie:603");
        var sends = 0;
        var first = runner.SingleFlightAsync(r.Admin, "restored-preparation", identity, async _ =>
        {
            reached.TrySetResult(); await release.Task;
            return await runner.RunAsync(Action(r.Admin, "restored-preparation", _ => { sends++; return Task.FromResult<ArrError?>(null); }));
        }, () => new ArrActionOutcome { Conflict = true }, default);
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try { r.Db.ReplaceWith(r.Db.Snapshot()!); }
        finally { release.TrySetResult(); }
        Assert.Equal(ArrActionStatus.Unknown, (await first).Status); Assert.Equal(0, sends);
    }

    [Fact]
    public async Task AnInternalSplitChildCannotBecomeAPublicRetryWhenACollidingActionExpires()
    {
        using var r = new L.Rig();
        Assert.Equal(201, (await r.Create(input: L.Seasons(1, 2, 3))).HttpStatus);
        var runner = new ArrActionRunner(r.Audit, new ArrConfirmationTokens(), () => r.Now);
        Assert.Equal(ArrActionStatus.Succeeded, (await runner.RunAsync(Action(r.Member, "split|go", _ => Task.FromResult<ArrError?>(null)))).Status);
        var split = await r.Create(input: L.Seasons(4, 5, 6), client: "split");
        Assert.Equal("split", split.Outcome);
        r.Now = r.Now.AddMinutes(11);
        var child = await r.Create(input: L.Seasons(4, 5, 6), client: "split|go");
        Assert.Equal(409, child.HttpStatus); Assert.Equal(PressChecks.Conflict, child.Reason);
        var exact = await r.Create(input: L.Seasons(4, 5, 6), client: "split");
        Assert.Equal(split.HeldRequestId, exact.HeldRequestId);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExistingRequestReceiptsMigrateWithoutOpeningSplitOrTrimAliases(bool split)
    {
        using var r = new L.Rig();
        if (split) await r.Create(input: L.Seasons(1, 2, 3));
        var input = split ? L.Seasons(4, 5, 6) : L.Movie();
        var first = await r.Create(input: input, client: "legacy");
        r.Db.Write((c, t) =>
        {
            using var cmd = c.CreateCommand(); cmd.Transaction = t;
            // This database already contains every numbered schema column.
            // Model the older additive receipt format by removing its tables;
            // relabeling it v2 would rerun frozen DDL against later columns.
            cmd.CommandText = "DROP TABLE request_search_slots; DROP TABLE retry_wants; DROP TABLE retry_owners; " +
                (split ? "" : "UPDATE request_inputs SET client_request_id=' '||client_request_id||' ' WHERE client_request_id='legacy'; " +
                "UPDATE wants SET client_request_id=' legacy ' WHERE client_request_id='legacy'; ");
            return cmd.ExecuteNonQuery();
        });
        r.Reopen();
        Assert.True(r.Db.Available, r.Db.UnavailableReason);
        var retry = await r.Create(input: input, client: " legacy ");
        Assert.Equal(200, retry.HttpStatus); Assert.Equal(first.RequestId, retry.RequestId);
        Assert.Equal(first.HeldRequestId, retry.HeldRequestId);
        Assert.Equal(PressChecks.Conflict, (await r.Create(input: L.Movie(604), client: "legacy")).Reason);
        Assert.True((await new ArrActionRunner(r.Audit, new ArrConfirmationTokens()).RunAsync(
            Action(r.Member, "legacy", _ => Task.FromResult<ArrError?>(null)))).Conflict);
        if (split) Assert.Equal(PressChecks.Conflict, (await r.Create(input: input, client: "legacy|go")).Reason);
    }

    [Theory]
    [InlineData("instance")]
    [InlineData("profile")]
    [InlineData("root")]
    public async Task APlainAskKeepsAllIncomingRoutingInItsDurableIdentity(string field)
    {
        using var r = new L.Rig();
        var input = L.Movie() with { InstanceId = "r1", ProfileId = 7, RootFolder = "/data/movies" };
        var first = await r.Create(r.Admin, input, "plain-routing"); Assert.Equal(201, first.HttpStatus);
        var changed = field switch
        {
            "instance" => input with { InstanceId = "r2" },
            "profile" => input with { ProfileId = 8 },
            _ => input with { RootFolder = "/data/other" },
        };
        var other = await r.Create(r.Admin, changed, "plain-routing");
        Assert.Equal(409, other.HttpStatus); Assert.Equal(PressChecks.Conflict, other.Reason);
        r.Policy.Before = (_, _) => throw new InvalidOperationException("An exact receipt does not revalidate routing.");
        Assert.Equal(first.RequestId, (await r.Create(r.Admin, input, "plain-routing")).RequestId);
        Assert.Single(r.Ledger.ForTitle(input.Key));
    }

    [Fact]
    public async Task ASecondOwnerCannotReleaseTheFirstOwnersSharedSearchClaims()
    {
        using var r = new L.Rig();
        var owners = r.Db.RetryOwners;
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        const string slot = "tv:tvdb:78874:s1:e4";
        var first = owners.ExecuteAsync(r.Admin, "claim-one", "action", "first", async _ =>
        {
            Assert.True(owners.ClaimSearch(slot, r.Now, 1)); reached.SetResult(); await release.Task; return true;
        }, () => false, () => false, default, r.Now);
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            Assert.True(await owners.ExecuteAsync(r.Admin, "claim-two", "action", "second", _ =>
            {
                owners.ReleaseSearch(new[] { slot });
                Assert.True(owners.SearchClaimed(slot, r.Now, 1));
                Assert.False(owners.ClaimSearch(slot, r.Now, 1));
                return Task.FromResult(true);
            }, () => false, () => false, default, r.Now));
        }
        finally { release.SetResult(); }
        Assert.True(await first);
    }


    [Theory]
    [InlineData("kind")]
    [InlineData("identity")]
    [InlineData("key")]
    [InlineData("person")]
    public async Task ADirectLedgerEntryMustMatchItsOwnPersonKeyKindAndIdentity(string difference)
    {
        using var r = new L.Rig();
        var user = difference == "person" ? r.Member : r.Admin;
        var key = difference == "key" ? "ledger-child" : "ledger-parent";
        var input = difference == "identity" ? L.Movie(604) : L.Movie();
        await r.Db.RetryOwners.ExecuteAsync(r.Admin, "ledger-parent", difference == "kind" ? "action" : "ask", L.Movie().Fingerprint, _ =>
        {
            var ask = r.Ledger.Create(user, new CreateRequest(key, input), r.Policy, r.Now);
            if (difference is "kind" or "identity")
            {
                Assert.Equal(409, ask.HttpStatus); Assert.Equal(PressChecks.Conflict, ask.Reason);
                Assert.Empty(r.Ledger.ForTitle(input.Key));
            }
            else
            {
                Assert.Equal(201, ask.HttpStatus);
                Assert.Equal("ask", r.Db.Read(c =>
                {
                    using var cmd = c.CreateCommand();
                    cmd.CommandText = "SELECT kind FROM retry_owners WHERE user_id=$u AND retry_key=$k";
                    cmd.Parameters.AddWithValue("$u", user.ToString("N")); cmd.Parameters.AddWithValue("$k", key);
                    return cmd.ExecuteScalar() as string;
                }));
            }
            return Task.FromResult(true);
        }, () => false, () => false, default, r.Now);
    }

}
