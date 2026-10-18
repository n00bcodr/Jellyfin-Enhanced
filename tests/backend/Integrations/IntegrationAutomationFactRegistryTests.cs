using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace JE.Tests;

/// <summary>
/// 4a review round 8: one registry (<see cref="AutomationFacts"/>) declares every fact the automatic-write check reads,
/// each either read in its final decision from memory or gathered with a version. The check's source is compiled and
/// every read it makes is classified by symbol: a read of a service the check holds (its policy, store, budgets,
/// eligibility, consents, the job's admission), a method of the configuration (secrets), a static call handed one of
/// those services, or one of its delegates. The gather step may only make registered versioned reads (and the listed
/// effects), the decision only registered decision reads, the stamp only the version samplers; every version source of a
/// gathered fact is sampled and compared; every registered reader is used; the gathered facts are exactly the versioned
/// ones. Rounds 7 and 8 found facts outside this (Jellyfin's administrator permission, the disk snapshots read twice);
/// a new one now fails here first.
/// </summary>
public class IntegrationAutomationFactRegistryTests
{
    private const string GateFile = "Services/Acquire/Automation/AutomationWriteGate.cs";

    // The services the check holds: a call on one of them reads a fact.
    private static readonly HashSet<string> Services = new(StringComparer.Ordinal) { "_policy", "_budgets", "_store", "_eligibility", "_consents", "admission" };

    // The check's delegates.
    private static readonly HashSet<string> Delegates = new(StringComparer.Ordinal) { "_config", "_now", "_secrets" };

    // What the stamp may read: the version samplers.
    private static readonly HashSet<string> Samplers = new(StringComparer.Ordinal)
    {
        "IAutomationConsents.Version", "IRequestPolicy.PermissionVersion", "AutomationWriteGate._secrets",
    };

    // How the stamp samples each version source (in StampOf), and compares it (in Stamp.Same).
    private static readonly Dictionary<string, (string Sampled, string Compared)> Sampled = new(StringComparer.Ordinal)
    {
        ["configuration"] = ("JsonSerializer.Serialize(config)", "Settings == other.Settings"),
        ["generation"] = ("db?.Generation", "Generation == other.Generation"),
        ["automation"] = ("db?.Automation.Sample()", "Automation == other.Automation"),
        ["person_settings"] = ("_consents?.Version(write.Requester)", "Person == other.Person"),
        ["jellyfin_user"] = ("_policy?.PermissionVersion(write.Requester)", "Jellyfin == other.Jellyfin"),
        ["secrets"] = ("_secrets()", "Secrets == other.Secrets"),
    };

    // The steps of the check, by method: the gather, the stamp, the decision (Final and everything it calls but the
    // stamp), and Check itself (the configuration read before the stamp).
    private static readonly string[] DecisionMethods = { "Final", "Decide", "Disk", "Run", "Requests", "Approval", "Breaker", "Budget", "Engine", "Unloaded", "Changed", "Hold", "Park", "Killed", "Unchecked", "Until" };

    /// <summary>What is wrong with the check's reads against the registry ("step: problem").</summary>
    internal static List<string> Problems(WriteGateWalk walk, IReadOnlyList<AutomationFact> registry)
    {
        var problems = new List<string>(AutomationFacts.Problems(registry));
        var (tree, model) = walk.Source(GateFile);
        var gate = tree.GetRoot().DescendantNodes().OfType<ClassDeclarationSyntax>().Single(c => c.Identifier.ValueText == "AutomationWriteGate");
        var methods = gate.Members.OfType<MethodDeclarationSyntax>().ToList();
        var versioned = registry.Where(f => f.Read == AutomationFactRead.Versioned).SelectMany(f => f.Readers).ToHashSet(StringComparer.Ordinal);
        var decision = registry.Where(f => f.Read == AutomationFactRead.Decision).SelectMany(f => f.Readers).ToHashSet(StringComparer.Ordinal);
        var used = new HashSet<string>(StringComparer.Ordinal);

        void Step(string step, IEnumerable<MethodDeclarationSyntax> bodies, ISet<string> allowed)
        {
            foreach (var body in bodies)
                foreach (var read in Reads(body, model))
                {
                    if (allowed.Contains(read.Name)) used.Add(step + ":" + read.Name);
                    else if (versioned.Contains(read.Name) || decision.Contains(read.Name) || Samplers.Contains(read.Name) || AutomationFacts.Effects.Contains(read.Name))
                        problems.Add(step + ": " + read.Name + " is read here, not in its registered step (" + read.Line + ")");
                    else problems.Add(step + ": " + read.Name + " reads a fact the registry doesn't list (" + read.Line + ")");
                }
        }

        Step("gather", methods.Where(m => m.Identifier.ValueText == "Gather"), versioned.Concat(AutomationFacts.Effects).ToHashSet(StringComparer.Ordinal));
        Step("stamp", methods.Where(m => m.Identifier.ValueText == "StampOf"), Samplers);
        Step("decision", methods.Where(m => DecisionMethods.Contains(m.Identifier.ValueText)), decision);
        Step("check", methods.Where(m => m.Identifier.ValueText is "Check"), new HashSet<string>(StringComparer.Ordinal) { "AutomationWriteGate._config" });
        // Every method that reads anything is one of the steps (CheckOne, for diagnostics, gathers and judges one gate).
        foreach (var other in methods.Where(m => m.Identifier.ValueText is not ("Gather" or "StampOf" or "Check" or "CheckOne") && !DecisionMethods.Contains(m.Identifier.ValueText)))
            foreach (var read in Reads(other, model))
                problems.Add(other.Identifier.ValueText + ": " + read.Name + " is read outside the check's steps (" + read.Line + ")");

        foreach (var fact in registry)
            foreach (var reader in fact.Readers)
            {
                var step = fact.Read == AutomationFactRead.Versioned ? "gather" : "decision";
                if (!used.Contains(step + ":" + reader) && !(reader == "AutomationWriteGate._config" && used.Contains("check:" + reader)))
                    problems.Add(fact.Id + ": " + reader + " is registered but the " + step + " never reads it");
            }

        // Every version source of a gathered fact is sampled and compared.
        var stamp = methods.Single(m => m.Identifier.ValueText == "StampOf").ToString();
        var same = gate.DescendantNodes().OfType<MethodDeclarationSyntax>().Single(m => m.Identifier.ValueText == "Same").ToString();
        foreach (var source in registry.Where(f => f.Version != null).Select(f => f.Version!).Append("generation").Distinct())
        {
            if (!Sampled.TryGetValue(source, out var how)) { problems.Add(source + ": no known sampler"); continue; }
            if (!stamp.Contains(how.Sampled, StringComparison.Ordinal)) problems.Add(source + ": the stamp doesn't sample it (" + how.Sampled + ")");
            if (!same.Contains(how.Compared, StringComparison.Ordinal)) problems.Add(source + ": the stamp doesn't compare it (" + how.Compared + ")");
        }

        return problems;
    }

    // The fact reads in one method ("Type.Member" and the line).
    private static IEnumerable<(string Name, string Line)> Reads(MethodDeclarationSyntax method, SemanticModel model)
    {
        foreach (var call in method.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            var line = call.SyntaxTree.GetText().Lines[call.GetLocation().GetLineSpan().StartLinePosition.Line].ToString().Trim();
            // A delegate the check holds.
            if (call.Expression is IdentifierNameSyntax { Identifier.ValueText: var d } && Delegates.Contains(d))
            {
                yield return ("AutomationWriteGate." + d, line);
                continue;
            }

            if (model.GetSymbolInfo(call).Symbol is not IMethodSymbol symbol) continue;
            var name = symbol.ContainingType?.Name + "." + symbol.Name;
            var receiver = call.Expression switch
            {
                MemberAccessExpressionSyntax access => access.Expression,
                MemberBindingExpressionSyntax => call.Ancestors().OfType<ConditionalAccessExpressionSyntax>().FirstOrDefault()?.Expression,
                _ => null,
            };
            if (receiver is IdentifierNameSyntax { Identifier.ValueText: var r } && Services.Contains(r))
                yield return (name, line);
            else if (symbol.ContainingType?.Name == "PluginConfiguration" && !symbol.IsStatic)
                yield return (name, line);
            else if (symbol.IsStatic && call.ArgumentList.Arguments.Any(a => a.Expression is IdentifierNameSyntax { Identifier.ValueText: var arg } && Services.Contains(arg)))
                yield return (name, line);
        }
    }

    [Fact]
    public void EveryFactTheCheckReadsIsRegisteredAndReadInItsStep()
    {
        var problems = Problems(WriteGateWalk.Plugin, AutomationFacts.All);
        if (problems.Count > 0) throw new Xunit.Sdk.XunitException(string.Join("\n", problems));
    }

    [Fact]
    public void TheGatheredFactsAreExactlyTheVersionedOnes()
    {
        var facts = typeof(AutomationWriteGate).GetNestedType("Facts", BindingFlags.NonPublic)!;
        var fields = facts.GetProperties(BindingFlags.Public | BindingFlags.Instance).Select(p => p.Name).Where(n => n is not "EngineFacts" and not "EqualityContract").OrderBy(n => n, StringComparer.Ordinal);
        var versioned = AutomationFacts.All.Where(f => f.Read == AutomationFactRead.Versioned).Select(f => f.Field!).OrderBy(n => n, StringComparer.Ordinal);
        Assert.Equal(versioned, fields);
        Assert.All(AutomationFacts.All, f => Assert.True(f.Read == AutomationFactRead.Decision ? f.Version == null : AutomationFacts.Versions.ContainsKey(f.Version!), f.Id));
    }

    // A registry entry with neither form, or a wrong one, is reported.
    [Fact]
    public void ARegisteredFactWithNeitherFormIsReported()
    {
        Assert.Empty(AutomationFacts.Problems(AutomationFacts.All));
        Assert.Contains("neither", Assert.Single(AutomationFacts.Problems(new[] { new AutomationFact("x", (AutomationFactRead)7, new[] { "X.Y" }) })), StringComparison.Ordinal);
        Assert.Single(AutomationFacts.Problems(new[] { new AutomationFact("x", AutomationFactRead.Versioned, new[] { "X.Y" }) }));
        Assert.Single(AutomationFacts.Problems(new[] { new AutomationFact("x", AutomationFactRead.Versioned, new[] { "X.Y" }, "nowhere", "X") }));
        Assert.Single(AutomationFacts.Problems(new[] { new AutomationFact("x", AutomationFactRead.Decision, new[] { "X.Y" }, "automation") }));
        Assert.Single(AutomationFacts.Problems(new[] { new AutomationFact("x", AutomationFactRead.Decision, Array.Empty<string>()) }));
        // A fact missing from the registry: its reads are reported as unregistered.
        var withoutConsent = AutomationFacts.All.Where(f => f.Id != "consent").ToList();
        Assert.Contains(Problems(WriteGateWalk.Plugin, withoutConsent), p => p.Contains("AutomationConsent.Allows reads a fact the registry doesn't list", StringComparison.Ordinal));
        // A versioned fact registered as a decision read.
        var adminAsDecision = AutomationFacts.All.Select(f => f.Id == "jellyfin_admin" ? f with { Read = AutomationFactRead.Decision, Version = null, Field = null } : f).ToList();
        Assert.Contains(Problems(WriteGateWalk.Plugin, adminAsDecision), p => p.Contains("IRequestPolicy.IsAdmin is read here, not in its registered step", StringComparison.Ordinal));
    }

    // Each case changes the check (the copy must still compile), and the registry test reports it.
    private static readonly Dictionary<string, (string Text, string Planted, string Reported)> Plants = new(StringComparer.Ordinal)
    {
        // A new storage read in the gather that nobody registered (all of a target's breakers).
        ["unregistered_gather_read"] = ("if (!string.IsNullOrEmpty(w.Target) && _store != null) facts = facts with { Breaker = _store.Breaker(w.Target) };",
            "if (!string.IsNullOrEmpty(w.Target) && _store != null) facts = facts with { Breaker = _store.Breakers().FirstOrDefault() ?? _store.Breaker(w.Target) };",
            "AutomationStore.Breakers reads a fact the registry doesn't list"),
        // A versioned fact read in the decision (the grant instead of Trusted).
        ["versioned_read_in_the_decision"] = ("_eligibility.Trusted(w.Requester)", "_eligibility.Granted(w.Requester)", "decision: AutomationEligibility.Granted is read here, not in its registered step"),
        // The Jellyfin permission read in the decision (it reads Jellyfin's database).
        ["permission_read_in_the_decision"] = ("_policy.RoleOf(w.Requester, admin, c)", "_policy.RoleOf(w.Requester, _policy.IsAdmin(w.Requester), c)", "decision: IRequestPolicy.IsAdmin is read here, not in its registered step"),
        // The disk verdicts gathered (a swap after the read would be missed) instead of read in the decision.
        ["disk_gathered"] = ("if (w.Input != null && _policy != null) _policy.WarmDisk(w.Input);", "if (w.Input != null && _policy != null) _ = _policy.Disk(w.Input, config);", "gather: IRequestPolicy.Disk is read here, not in its registered step"),
        // A version source no longer sampled.
        ["permission_version_not_sampled"] = ("_policy?.PermissionVersion(write.Requester) ?? 0", "0L", "jellyfin_user: the stamp doesn't sample it"),
        // A version source sampled but not compared.
        ["secrets_not_compared"] = ("&& Jellyfin == other.Jellyfin && Secrets == other.Secrets;", "&& Jellyfin == other.Jellyfin;", "secrets: the stamp doesn't compare it"),
        // A read made outside the check's steps.
        ["read_outside_the_steps"] = ("public static IReadOnlyList<string> Gates { get; } = Ordered.Select(g => g.Id).ToArray();",
            "public static IReadOnlyList<string> Gates { get; } = Ordered.Select(g => g.Id).ToArray();\n        internal bool Planted(Guid u) => _store?.HasGrant(u) == true;",
            "Planted: AutomationStore.HasGrant is read outside the check's steps"),
    };

    public static IEnumerable<object[]> PlantCases() => Plants.Keys.Select(k => new object[] { k });

    [Theory]
    [MemberData(nameof(PlantCases))]
    public void TheRegistryTestReportsAFactReadOutsideIt(string plant)
    {
        var (text, planted, reported) = Plants[plant];
        var walk = WriteGateWalk.Plugin.With(GateFile, source =>
        {
            var at = source.IndexOf(text, StringComparison.Ordinal);
            Assert.True(at >= 0 && source.IndexOf(text, at + 1, StringComparison.Ordinal) < 0, plant + ": \"" + text + "\" must be there once");
            return source[..at] + planted + source[(at + text.Length)..];
        });
        var errors = walk.Errors(GateFile);
        if (errors.Count > 0) throw new Xunit.Sdk.XunitException(string.Join("\n", errors));
        Assert.Contains(Problems(walk, AutomationFacts.All), p => p.Contains(reported, StringComparison.Ordinal));
    }

    // ------------------------------------------------------------------ the seqlock helper

    [Fact]
    public void AVersionIsOddWhileAChangeIsMadeAndMovedWhenItIsDone()
    {
        var version = new FactVersion();
        var start = version.Sample();
        Assert.True(FactVersion.Settled(start));
        long during = 0;
        version.Mutate(() => during = version.Sample());
        Assert.False(FactVersion.Settled(during));
        Assert.True(during % 2 != 0 || during >= 1L << 40);
        var after = version.Sample();
        Assert.True(FactVersion.Settled(after));
        Assert.NotEqual(start, after);
        Assert.Equal(7, version.Mutate(() => 7));
    }

    // A change that throws inside the bracket still finishes it: the version is settled again (nothing is held for
    // ever) and has moved (whatever part of the change was seen is read again): the safe choice.
    [Fact]
    public async Task AChangeThatThrowsStillFinishesItsBracketAndMovesTheVersion()
    {
        var version = new FactVersion();
        var start = version.Sample();
        Assert.Throws<InvalidOperationException>(() => version.Mutate(() => throw new InvalidOperationException("boom")));
        var after = version.Sample();
        Assert.True(FactVersion.Settled(after));
        Assert.NotEqual(start, after);
        await Assert.ThrowsAsync<InvalidOperationException>(() => version.MutateAsync(async () => { await Task.Yield(); throw new InvalidOperationException("boom"); }));
        Assert.True(FactVersion.Settled(version.Sample()));
        Assert.NotEqual(after, version.Sample());
    }

    // Two changes that overlap: the version isn't settled until both are done (the parity alone would say it is).
    [Fact]
    public async Task OverlappingChangesKeepTheVersionUnsettledUntilBothAreDone()
    {
        var version = new FactVersion();
        using var first = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var one = Task.Run(() => version.Mutate(() => { first.Set(); release.Wait(TimeSpan.FromSeconds(10)); }));
        Assert.True(first.Wait(TimeSpan.FromSeconds(10)));
        long during = 0;
        version.Mutate(() => { });
        during = version.Sample();
        Assert.False(FactVersion.Settled(during));
        release.Set();
        await one.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.True(FactVersion.Settled(version.Sample()));
        var both = new FactVersion();
        long inside = 0;
        both.Mutate(() => both.Mutate(() => inside = both.Sample()));
        Assert.Equal(0, inside % 2);
        Assert.False(FactVersion.Settled(inside));
    }

    // A change to a database fact that fails (rolled back) still moves the automation version: the check reads again.
    [Fact]
    public void AFailedAutomationWriteMovesTheAutomationVersion()
    {
        using var e = new IntegrationAutomationTests.Engine();
        var start = e.R.Db.Automation.Sample();
        Assert.Throws<InvalidOperationException>(() => e.R.Db.WriteAutomation<int>((_, _) => throw new InvalidOperationException("boom")));
        var after = e.R.Db.Automation.Sample();
        Assert.True(FactVersion.Settled(after));
        Assert.NotEqual(start, after);
        // An ordinary write doesn't touch it.
        e.R.Db.Write((c, t) => 0);
        Assert.Equal(after, e.R.Db.Automation.Sample());
        // A breaker failure and a reset do, and the check never sees it odd once they returned.
        e.Store.Failure("x", "r", e.R.Now);
        Assert.NotEqual(after, e.R.Db.Automation.Sample());
        Assert.True(FactVersion.Settled(e.R.Db.Automation.Sample()));
    }
}
