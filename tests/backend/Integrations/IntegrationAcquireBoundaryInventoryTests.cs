using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;

namespace JE.Tests;

/// <summary>Bounded inventories supplement the executable ownership, ordering and mode regressions.</summary>
public class IntegrationAcquireBoundaryInventoryTests
{
    private static string Root([CallerFilePath] string file = "")
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(file)!);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "Jellyfin.Plugin.JellyfinEnhanced", "Services"))) dir = dir.Parent;
        return Path.Combine(dir!.FullName, "Jellyfin.Plugin.JellyfinEnhanced");
    }

    private static string Method(string text, string name)
    {
        var match = Regex.Match(text, @"(?:public|internal|private)\s+(?:static\s+)?(?:async\s+)?[^\n=;{]+\b" + name + @"(?:<[^>]+>)?\(");
        Assert.True(match.Success, "missing entry: " + name);
        var start = text.IndexOf('{', match.Index);
        var end = text.IndexOf("\n        }", start, StringComparison.Ordinal);
        Assert.InRange(end - start, 1, 60000);
        return text[start..end];
    }

    [Fact]
    public void EveryPublicRetryEntryReservesBeforeItsFirstAwait()
    {
        var root = Root();
        var entries = new (string File, string Method, string Owner)[]
        {
            ("Services/Acquire/Requests/RequestService.cs", "CreateAsync", "RetryOwners.ExecuteAsync"),
            ("Services/Acquire/Requests/ArrAddService.cs", "AddAsync", "RetryOwners.ExecuteAsync"),
            ("Services/Acquire/Requests/RequestSearchService.cs", "SearchAsync", "Runner.SingleFlightAsync"),
            ("Services/Acquire/ArrQueueActionService.cs", "RunAsync", "_runner.SingleFlightAsync"),
            ("Services/Arr/Live/ArrWebhookProvisioner.cs", "ProvisionAsync", "_runner.SingleFlightAsync"),
            ("Services/Arr/Live/ArrWebhookProvisioner.cs", "RemoveAsync", "_runner.SingleFlightAsync"),
            ("Services/Arr/ArrActionRunner.cs", "RunAsync", "_owners.ExecuteAsync"),
            ("Services/Acquire/ArrManageService.cs", "SearchCoreAsync", "_runner.SingleFlightAsync"),
            ("Services/Acquire/ArrManageService.cs", "SearchCommandAsync", "_runner.SingleFlightAsync"),
        };
        foreach (var entry in entries)
        {
            var body = Method(File.ReadAllText(Path.Combine(root, entry.File)), entry.Method);
            var awaited = body.IndexOf("await ", StringComparison.Ordinal);
            var owner = body.IndexOf(entry.Owner, StringComparison.Ordinal);
            Assert.True(awaited >= 0 && owner > awaited && owner - awaited < 100, entry.File + ":" + entry.Method + " awaits before reservation");
        }
        var ledger = Method(File.ReadAllText(Path.Combine(root, "Services/Acquire/Requests/RequestLedger.cs")), "Create");
        Assert.Contains("RetryOwners.ExecuteAsync", ledger);
        foreach (var field in new[] { "lease.User != user", "lease.Key != RetryOwners.Key(request.ClientRequestId)", "lease.Kind !=", "lease.Identity != Idempotency(request, normalized)" }) Assert.Contains(field, ledger);
        var production = string.Join('\n', Files(root).Select(File.ReadAllText));
        Assert.DoesNotContain("KeyTakenElsewhere", production);
        var runner = File.ReadAllText(Path.Combine(root, "Services/Arr/ArrActionRunner.cs"));
        Assert.DoesNotContain("_recent", runner); Assert.DoesNotContain("_flights", runner);
        var executions = Files(root).SelectMany(file => Regex.Matches(File.ReadAllText(file), @"\.Execute\s*\(").Select(match => Path.GetRelativePath(root, file))).ToArray();
        Assert.Equal(new[] { "Controllers/JellyfinEnhancedController.cs", "Services/Arr/ArrActionRunner.cs" }, executions.OrderBy(path => path));
    }

    [Fact]
    public void EveryEvidenceWriterHasAnEnumeratedOrderedCaller()
    {
        var root = Root();
        var allowed = new HashSet<string>(StringComparer.Ordinal)
        {
            "EvaluateMovieAsync", "EvaluateSeries", "Baselines", "MergeOpenBatches", "AddToBatch", "FlushBatchesCore",
            "ScanRequestsCore", "ForgetTitle", "SetFollowCoreAsync", "FlushBatch", "RemindCoreAsync", "AdminChecksCoreAsync", "TrySendTestCore", "DropBatch", "WaitBatch",
        };
        var calls = new Regex(@"\.(SetWatch|DeleteWatch|SetBatch|DeleteBatch|DeleteBatchIf|TryMark|KeepMark|ClaimMark|SetSeerrSeen|ResetSeerrSeen|ForgetTitle|SetFollow)\s*\(");
        var declarations = new Regex(@"(?:public|internal|private)\s+(?:static\s+)?(?:async\s+)?[^\n=;{]+\b(?<name>\w+)\(");
        var count = 0;
        foreach (var file in Files(root))
        {
            var text = File.ReadAllText(file);
            foreach (Match call in calls.Matches(text))
            {
                count++;
                if (Path.GetFileName(file) == "NotifyStore.cs") continue; // every store write enters Ordering.Run
                Assert.Equal("NotificationService.cs", Path.GetFileName(file));
                var name = declarations.Matches(text[..call.Index]).Last().Groups["name"].Value;
                Assert.True(allowed.Contains(name), "unregistered evidence writer " + file + ":" + name);
            }
        }
        Assert.InRange(count, 20, 90);
        var service = File.ReadAllText(Path.Combine(root, "Services/Acquire/Notify/NotificationService.cs"));
        foreach (var entry in new[] { "TickAsync", "SetFollowAsync", "EvaluateAsync", "ScanRequests", "ScanLedger", "FlushBatches", "DeliverRequestNoticesAsync", "AdminChecksAsync", "RebuildInterest", "RemindAsync", "NoteAlertsPaused", "Notify" })
            // An entry acquires the order itself (inside its admitted background scope where it reads Seerr facts).
            Assert.Matches(@"\b" + entry + @"\([^\n]*\)\s*(?://[^\n]*\n\s*)*=> (?:SeerrFacts\.BackgroundAsync\(token => )?_store\.Ordering\.Run", service);
        var store = File.ReadAllText(Path.Combine(root, "Services/Acquire/Notify/NotifyStore.cs"));
        Assert.Contains("WithWriteOrder(() =>", store);
        Assert.Contains("Ordering.Run(work)", store);
        Assert.Single(Files(root).SelectMany(file => Regex.Matches(File.ReadAllText(file), @"\.ForEvaluation\s*\(").Select(match => file)));
        Assert.DoesNotContain("=> _db.Write(", store);
        Assert.Single(Regex.Matches(store, @"_db\.(?:Write|WriteIf)\s*\("));
        Assert.Contains("public NotifyStore Store => _publicStore;", service);
    }

    [Fact]
    public void SeerrAskAndSearchIdentityBoundariesRemainExplicit()
    {
        var root = Root();
        var status = File.ReadAllText(Path.Combine(root, "Services/Acquire/ArrStatusService.cs"));
        var press = Method(status, "PressAsync");
        Assert.Contains("seerr ? null :", press);
        Assert.Contains("if (seerr && route == PressChecks.Ask)", press);
        Assert.Contains("if (!seerr && gather.UnderWay", press);
        Assert.DoesNotContain("distinct.Any(t => AskedBy", status);
        var declarations = new Regex(@"(?:public|internal|private)\s+(?:static\s+)?(?:async\s+)?[^\n=;{]+\b(?<name>\w+)\(");
        var fresh = Regex.Matches(status, @"\bfresh:\s*");
        Assert.Equal(2, fresh.Count);
        foreach (Match call in fresh) Assert.Equal("PressAsync", declarations.Matches(status[..call.Index]).Last().Groups["name"].Value);
        foreach (var file in new[] { "Services/Acquire/Requests/RequestSearchService.cs", "Controllers/RequestsHubController.cs" })
            Assert.Contains("PressChecks.IncomingIdentity(", File.ReadAllText(Path.Combine(root, file)));
    }

    [Fact]
    public void EveryBoundQueueAndWebhookActionPersistsItsConnectionTag()
    {
        var root = Root();
        foreach (var name in new[] { "RemoveRequest", "CommandRequest" })
        {
            var body = Method(File.ReadAllText(Path.Combine(root, "Services/Acquire/ArrQueueActionService.cs")), name);
            Assert.Contains("Binding = ArrClientFactory.Tag(bound)", body);
        }
        foreach (var name in new[] { "ProvisionLockedAsync", "RemoveLockedAsync" })
        {
            var body = Method(File.ReadAllText(Path.Combine(root, "Services/Arr/Live/ArrWebhookProvisioner.cs")), name);
            Assert.Contains("Binding = bound.Ok ? ArrClientFactory.Tag(bound.Value!) : null", body);
        }
    }

    private static IEnumerable<string> Files(string root) => Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
        .Where(f => !f.Contains(Path.DirectorySeparatorChar + "obj" + Path.DirectorySeparatorChar) && !f.Contains(Path.DirectorySeparatorChar + "bin" + Path.DirectorySeparatorChar));
}
