using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace JE.Tests;

/// <summary>
/// The Phase 1–2 write path: one run per idempotency key, read-back, honest "unknown" outcomes,
/// an audit line for every outcome, and confirmation tokens for destructive actions.
/// </summary>
public class IntegrationArrActionRunnerTests
{
    private sealed class Rig : IDisposable
    {
        public IntegrationEnvironment Env { get; } = new();
        public DateTimeOffset Now { get; set; } = new(2026, 10, 11, 12, 0, 0, TimeSpan.Zero);
        public ArrAuditLog Audit { get; }
        public ArrConfirmationTokens Tokens { get; }
        public ArrActionRunner Runner { get; }
        public Guid Admin { get; } = Guid.NewGuid();
        public Rig(long maxAuditBytes = 1024 * 1024)
        {
            Audit = new ArrAuditLog(Path.Combine(Env.Root, ArrAuditLog.FileName), maxAuditBytes, 3);
            Tokens = new ArrConfirmationTokens(TimeSpan.FromMinutes(2), () => Now);
            Runner = new ArrActionRunner(Audit, Tokens, () => Now);
        }
        public ArrActionRequest Request(Func<CancellationToken, Task<ArrError?>> execute, Func<CancellationToken, Task<ArrReadBack>>? readBack = null,
            string key = "click-1", ArrActionTier tier = ArrActionTier.Change, string? token = null, string target = "movie:42") => new()
        {
            Action = "movie.search",
            InstanceId = "6f1c0c2e-6f39-4c39-9a51-2f7f1b8d0a11",
            Target = target,
            UserId = Admin,
            UserName = "admin",
            IdempotencyKey = key,
            Tier = tier,
            ConfirmationToken = token,
            Execute = execute,
            ReadBack = readBack,
            Details = new Dictionary<string, string> { ["title"] = "The Matrix" },
        };
        public void Dispose() => Env.Dispose();
    }

    private static Task<ArrError?> Ok(CancellationToken _) => Task.FromResult<ArrError?>(null);

    [Fact]
    public async Task ASuccessfulWriteIsReadBackAndAudited()
    {
        using var rig = new Rig();
        var outcome = await rig.Runner.RunAsync(rig.Request(Ok, _ => Task.FromResult(new ArrReadBack { Confirmed = true, Summary = "search command queued" })));
        Assert.Equal(ArrActionStatus.Succeeded, outcome.Status);
        Assert.Equal("search command queued", outcome.ReadBack!.Summary);
        var entry = Assert.Single(rig.Audit.ReadRecent(10));
        Assert.Equal((outcome.AuditId, "succeeded", "movie.search", "movie:42", 2, "search command queued"), (entry.Id, entry.Outcome, entry.Action, entry.Target, entry.Tier, entry.ReadBack));
        Assert.Equal(rig.Admin.ToString("N"), entry.UserId);
        Assert.Equal("The Matrix", entry.Details!["title"]);
        if (!OperatingSystem.IsWindows())
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(rig.Audit.FilePath));
    }

    [Fact]
    public async Task TheSameClickRunsOnceAndConcurrentDuplicatesShareTheOutcome()
    {
        using var rig = new Rig();
        var calls = 0;
        var gate = new TaskCompletionSource();
        async Task<ArrError?> Slow(CancellationToken _) { Interlocked.Increment(ref calls); await gate.Task; return null; }
        var first = rig.Runner.RunAsync(rig.Request(Slow));
        var second = rig.Runner.RunAsync(rig.Request(Slow));
        gate.SetResult();
        var results = await Task.WhenAll(first, second);
        Assert.Equal(1, calls);
        Assert.Single(results, r => r.Replayed);
        Assert.Equal(results[0].AuditId, results[1].AuditId);
        var third = await rig.Runner.RunAsync(rig.Request(Slow));
        Assert.True(third.Replayed);
        Assert.Equal(1, calls);
        // A different click (key) runs again; so does the same key after the window.
        await rig.Runner.RunAsync(rig.Request(Slow, key: "click-2"));
        rig.Now = rig.Now.AddMinutes(11);
        await rig.Runner.RunAsync(rig.Request(Slow));
        Assert.Equal(3, calls);
        Assert.Equal(3, rig.Audit.ReadRecent(10).Count);
    }

    [Fact]
    public async Task ARefusedWriteFailsWithoutReadBack()
    {
        using var rig = new Rig();
        var readBacks = 0;
        var outcome = await rig.Runner.RunAsync(rig.Request(
            _ => Task.FromResult<ArrError?>(new ArrError(ArrErrorKind.Validation, "The instance rejected the request. Path is already configured", 400)),
            _ => { readBacks++; return Task.FromResult(new ArrReadBack { Confirmed = true }); }));
        Assert.Equal(ArrActionStatus.Failed, outcome.Status);
        Assert.Equal(0, readBacks);
        var entry = Assert.Single(rig.Audit.ReadRecent(10));
        Assert.Equal(("failed", "Validation"), (entry.Outcome, entry.Error));
    }

    [Theory]
    [InlineData(true, ArrActionStatus.Succeeded)]
    [InlineData(false, ArrActionStatus.Unknown)]
    [InlineData(null, ArrActionStatus.Unknown)]
    public async Task AMaybeSentTimeoutIsResolvedOnlyByAPositiveReadBack(bool? confirmed, ArrActionStatus expected)
    {
        using var rig = new Rig();
        var outcome = await rig.Runner.RunAsync(rig.Request(
            _ => Task.FromResult<ArrError?>(new ArrError(ArrErrorKind.Timeout, "slow")),
            _ => Task.FromResult(new ArrReadBack { Confirmed = confirmed, Summary = "checked" })));
        Assert.Equal(expected, outcome.Status);
    }

    [Fact]
    public async Task AnAcceptedWriteTheReadBackCannotSeeIsUnknownAndAFailingReadBackStaysUnverified()
    {
        using var rig = new Rig();
        var notVisible = await rig.Runner.RunAsync(rig.Request(Ok, _ => Task.FromResult(new ArrReadBack { Confirmed = false, Summary = "queue row still there" })));
        Assert.Equal(ArrActionStatus.Unknown, notVisible.Status);
        var throwing = await rig.Runner.RunAsync(rig.Request(Ok, _ => throw new InvalidOperationException("boom"), key: "click-2"));
        Assert.Equal(ArrActionStatus.Succeeded, throwing.Status);
        Assert.Null(throwing.ReadBack!.Confirmed);
    }

    [Theory]
    [InlineData(true, ArrActionStatus.Succeeded)]
    [InlineData(null, ArrActionStatus.Succeeded)]
    [InlineData(false, ArrActionStatus.Unknown)]
    public async Task AWriteTheArrAcceptedIsNeverFailedEvenWhenItsReplyWasUnreadable(bool? confirmed, ArrActionStatus expected)
    {
        using var rig = new Rig();
        var readBacks = 0;
        var outcome = await rig.Runner.RunAsync(rig.Request(
            _ => Task.FromResult<ArrError?>(new ArrError(ArrErrorKind.InvalidResponse, "The instance returned an empty response.", 200) { Accepted = true }),
            _ => { readBacks++; return Task.FromResult(new ArrReadBack { Confirmed = confirmed, Summary = "checked" }); }));
        Assert.Equal(expected, outcome.Status);
        Assert.Equal(1, readBacks);
        Assert.Equal(expected.ToString().ToLowerInvariant(), Assert.Single(rig.Audit.ReadRecent(10)).Outcome);

        // No read-back: the arr's 2xx is the answer.
        var noCheck = await rig.Runner.RunAsync(rig.Request(
            _ => Task.FromResult<ArrError?>(new ArrError(ArrErrorKind.TooLarge, "big", 201) { Accepted = true }), key: "click-2"));
        Assert.Equal(ArrActionStatus.Succeeded, noCheck.Status);
    }

    [Fact]
    public async Task EveryActionLeavesAStartedLineSoAnInterruptedOneShowsAsUnknown()
    {
        using var rig = new Rig();
        var seenWhileRunning = new List<ArrAuditEntry>();
        var outcome = await rig.Runner.RunAsync(rig.Request(_ =>
        {
            // What the audit shows if Jellyfin stops right now.
            seenWhileRunning.AddRange(rig.Audit.ReadRecent(10));
            return Task.FromResult<ArrError?>(null);
        }));
        var interrupted = Assert.Single(seenWhileRunning);
        Assert.Equal(("unknown", outcome.AuditId), (interrupted.Outcome, interrupted.Id));
        Assert.Contains("No result was recorded", interrupted.Message);
        var lines = File.ReadAllLines(rig.Audit.FilePath);
        Assert.Equal(2, lines.Length);
        Assert.Contains("\"started\"", lines[0]);
        // Read back as one entry: the result.
        Assert.Equal("succeeded", Assert.Single(rig.Audit.ReadRecent(10)).Outcome);
    }

    [Fact]
    public async Task WithoutAWritableAuditLogDataIsNeverDeletedAndOtherOutcomesSayTheyWereNotAudited()
    {
        using var env = new IntegrationEnvironment();
        var blocker = Path.Combine(env.Root, "not-a-folder");
        File.WriteAllText(blocker, "");
        var audit = new ArrAuditLog(Path.Combine(blocker, ArrAuditLog.FileName), 1024 * 1024, 3);
        var now = DateTimeOffset.UtcNow;
        var tokens = new ArrConfirmationTokens(TimeSpan.FromMinutes(2), () => now);
        using var database = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.AcquireDatabase(Path.Combine(env.Root, "acquire.db"));
        var runner = new ArrActionRunner(audit, tokens, database);
        var admin = Guid.NewGuid();
        var calls = 0;
        ArrActionRequest Make(ArrActionTier tier, string key, string? token) => new()
        {
            Action = "queue.remove", InstanceId = "6f1c0c2e-6f39-4c39-9a51-2f7f1b8d0a11", Target = "queue:7", UserId = admin,
            IdempotencyKey = key, Tier = tier, ConfirmationToken = token,
            Execute = _ => { calls++; return Task.FromResult<ArrError?>(null); },
        };

        var token = tokens.Issue(admin, "queue.remove", "6f1c0c2e-6f39-4c39-9a51-2f7f1b8d0a11", "queue:7").Token;
        var destructive = await runner.RunAsync(Make(ArrActionTier.Destructive, "d", token));
        Assert.Equal(ArrActionStatus.Rejected, destructive.Status);
        Assert.Equal(0, calls);
        Assert.False(destructive.Audited);

        var change = await runner.RunAsync(Make(ArrActionTier.Change, "c", null));
        Assert.Equal(ArrActionStatus.Succeeded, change.Status);
        Assert.Equal(1, calls);
        Assert.False(change.Audited);
        Assert.Equal(string.Empty, change.AuditId);
    }

    [Fact]
    public async Task AnExceptionMidWriteIsUnknownNotFailed()
    {
        using var rig = new Rig();
        var outcome = await rig.Runner.RunAsync(rig.Request(_ => throw new InvalidOperationException("bug")));
        Assert.Equal(ArrActionStatus.Unknown, outcome.Status);
        Assert.Equal(ArrErrorKind.Internal, outcome.Error!.Kind);
        Assert.Equal("unknown", Assert.Single(rig.Audit.ReadRecent(10)).Outcome);
    }

    [Fact]
    public async Task DestructiveActionsNeedAFreshTokenForThatExactActionAndUser()
    {
        using var rig = new Rig();
        var calls = 0;
        Task<ArrError?> Delete(CancellationToken _) { calls++; return Task.FromResult<ArrError?>(null); }

        var missing = await rig.Runner.RunAsync(rig.Request(Delete, tier: ArrActionTier.Destructive));
        Assert.Equal(ArrActionStatus.Rejected, missing.Status);
        Assert.Equal("confirmation_required", rig.Audit.ReadRecent(1)[0].Error);

        var (token, expires) = rig.Tokens.Issue(rig.Admin, "movie.search", "6f1c0c2e-6f39-4c39-9a51-2f7f1b8d0a11", "movie:42");
        Assert.Equal(rig.Now.AddMinutes(2), expires);
        var wrongTarget = await rig.Runner.RunAsync(rig.Request(Delete, tier: ArrActionTier.Destructive, token: token, target: "movie:43", key: "k2"));
        Assert.Equal(ArrActionStatus.Rejected, wrongTarget.Status);
        Assert.Equal("confirmation_mismatch", rig.Audit.ReadRecent(1)[0].Error);

        // The mismatch consumed it: tokens are single use even when misused.
        var reused = await rig.Runner.RunAsync(rig.Request(Delete, tier: ArrActionTier.Destructive, token: token, key: "k3"));
        Assert.Equal(ArrActionStatus.Rejected, reused.Status);

        var (fresh, _) = rig.Tokens.Issue(rig.Admin, "movie.search", "6F1C0C2E-6F39-4C39-9A51-2F7F1B8D0A11", "movie:42");
        var ok = await rig.Runner.RunAsync(rig.Request(Delete, tier: ArrActionTier.Destructive, token: fresh, key: "k4"));
        Assert.Equal(ArrActionStatus.Succeeded, ok.Status);
        var again = await rig.Runner.RunAsync(rig.Request(Delete, tier: ArrActionTier.Destructive, token: fresh, key: "k5"));
        Assert.Equal(ArrActionStatus.Rejected, again.Status);
        Assert.Equal(1, calls);

        var (expired, _) = rig.Tokens.Issue(rig.Admin, "movie.search", "6f1c0c2e-6f39-4c39-9a51-2f7f1b8d0a11", "movie:42");
        rig.Now = rig.Now.AddMinutes(3);
        Assert.Equal(ArrActionStatus.Rejected, (await rig.Runner.RunAsync(rig.Request(Delete, tier: ArrActionTier.Destructive, token: expired, key: "k6"))).Status);
        Assert.False(rig.Tokens.TryConsume("not-a-token", rig.Admin, "movie.search", "x", "y", out var reason));
        Assert.Equal("confirmation_invalid_or_expired", reason);
        var (otherUsers, _) = rig.Tokens.Issue(Guid.NewGuid(), "movie.search", "6f1c0c2e-6f39-4c39-9a51-2f7f1b8d0a11", "movie:42");
        Assert.Equal(ArrActionStatus.Rejected, (await rig.Runner.RunAsync(rig.Request(Delete, tier: ArrActionTier.Destructive, token: otherUsers, key: "k7"))).Status);
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task ARejectedClickCanBeConfirmedAndRetriedWithTheSameKey()
    {
        using var rig = new Rig();
        Assert.Equal(ArrActionStatus.Rejected, (await rig.Runner.RunAsync(rig.Request(Ok, tier: ArrActionTier.Destructive))).Status);
        var (token, _) = rig.Tokens.Issue(rig.Admin, "movie.search", "6f1c0c2e-6f39-4c39-9a51-2f7f1b8d0a11", "movie:42");
        var confirmed = await rig.Runner.RunAsync(rig.Request(Ok, tier: ArrActionTier.Destructive, token: token));
        Assert.Equal(ArrActionStatus.Succeeded, confirmed.Status);
        Assert.False(confirmed.Replayed);
    }

    [Fact]
    public async Task TheAuditFileRotatesAndReadsNewestFirstAcrossFiles()
    {
        using var rig = new Rig(maxAuditBytes: 1024);
        for (var i = 0; i < 12; i++)
        {
            await rig.Runner.RunAsync(rig.Request(Ok, key: "click-" + i));
        }
        Assert.True(File.Exists(rig.Audit.FilePath + ".1"));
        Assert.False(File.Exists(rig.Audit.FilePath + ".4"));
        Assert.All(new[] { rig.Audit.FilePath, rig.Audit.FilePath + ".1" }, f => Assert.True(new FileInfo(f).Length <= 1024));
        var recent = rig.Audit.ReadRecent(3);
        Assert.Equal(3, recent.Count);
        Assert.True(recent[0].Time >= recent[2].Time);
        // Every line is one JSON object (append-only JSONL).
        foreach (var line in File.ReadAllLines(rig.Audit.FilePath)) JsonDocument.Parse(line).Dispose();
    }
}
