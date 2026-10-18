using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace JE.Tests;

/// <summary>
/// 4a review round 8: one registry (<see cref="AutomationFacts"/>) declares every fact the automatic-write check reads,
/// each either read in its final decision from memory or gathered with a version. Round 9 (4a-security-r9-3): the
/// check's source is classified on the Roslyn SEMANTIC model. Round 8 knew a service call only by its receiver's name
/// (<c>_store.X()</c>), so <c>var store = _store; store.Breakers()</c>, <c>this._store.Breakers()</c> or a helper that
/// returns the store read a fact unseen. Now a read is any call or property read whose receiver (through local aliases,
/// <c>this.</c>, helper properties and methods, <see cref="SemanticFlow"/>) is one of the check's services (a field it
/// holds, the job's admission, or any value of a service type), any call handed one, a configuration method, or one of
/// its delegates. The gather step may only make registered versioned reads (and the listed effects), the decision only
/// registered decision reads, the stamp only the version samplers; every version source of a gathered fact is sampled
/// into its own slot of the stamp, from its own sampler, checked settled and compared; a person's fact and its version
/// are both read for the requester; every registered reader is used; the gathered facts are exactly the versioned ones.
/// </summary>
public class IntegrationAutomationFactRegistryTests
{
    private const string GateFile = "Services/Acquire/Automation/AutomationWriteGate.cs";

    // The types whose calls and properties read stored or shared state (and anything implementing them).
    private static readonly HashSet<string> ServiceTypes = new(StringComparer.Ordinal)
    {
        "IRequestPolicy", "AutomationBudgets", "AutomationStore", "AutomationEligibility", "IAutomationConsents", "ISendAdmission", "IAutomationTrust",
        "AcquireDatabase", "SecretsStore", "UserConfigurationManager", "RequestLedger", "ArrStateStore", "JellyfinEnhanced", "IUserManager", "IArrJellyfinView",
    };

    // What the stamp may read: the version samplers.
    private static readonly HashSet<string> Samplers = new(StringComparer.Ordinal)
    {
        "IAutomationConsents.Version", "IRequestPolicy.PermissionVersion", "AutomationWriteGate._secrets",
        "AutomationStore.Database", "AutomationBudgets.Database", "AcquireDatabase.Generation", "AcquireDatabase.Automation",
    };

    // Each version source: the stamp's slot it is sampled into, and the sampler that slot must hold.
    private static readonly Dictionary<string, (string Slot, string Sampler)> Sampled = new(StringComparer.Ordinal)
    {
        ["configuration"] = ("Settings", "JsonSerializer.Serialize"),
        ["generation"] = ("Generation", "AcquireDatabase.Generation"),
        ["automation"] = ("Automation", "AcquireDatabase.Automation"),
        ["person_settings"] = ("Person", "IAutomationConsents.Version"),
        ["jellyfin_user"] = ("Jellyfin", "IRequestPolicy.PermissionVersion"),
        ["secrets"] = ("Secrets", "AutomationWriteGate._secrets"),
    };

    // The version sources kept per person: their fact and their sample must both be read for the requester.
    private static readonly HashSet<string> PerPerson = new(StringComparer.Ordinal) { "person_settings", "jellyfin_user" };

    // The steps of the check, by method: the gather, the stamp, the decision (Final and everything it calls but the
    // stamp), and Check itself (the configuration read before the stamp).
    private static readonly string[] DecisionMethods = { "Final", "Decide", "Disk", "Run", "Requests", "Approval", "Breaker", "Budget", "Engine", "Unloaded", "Changed", "Hold", "Park", "Killed", "Unchecked", "Until" };

    /// <summary>One read: the reader ("Type.Member"), its node and the line.</summary>
    private sealed record Read(string Name, SyntaxNode Node, SemanticModel Model, string Line);

    /// <summary>What is wrong with the check's reads against the registry ("step: problem").</summary>
    internal static List<string> Problems(WriteGateWalk walk, IReadOnlyList<AutomationFact> registry)
    {
        var problems = new List<string>(AutomationFacts.Problems(registry));
        var (tree, model) = walk.Source(GateFile);
        var gate = tree.GetRoot().DescendantNodes().OfType<ClassDeclarationSyntax>().Single(c => c.Identifier.ValueText == "AutomationWriteGate");
        var gateType = model.GetDeclaredSymbol(gate)!;
        var methods = gate.Members.OfType<MethodDeclarationSyntax>().ToList();
        var reads = new Reads(walk, gateType);
        var versioned = registry.Where(f => f.Read == AutomationFactRead.Versioned).SelectMany(f => f.Readers).ToHashSet(StringComparer.Ordinal);
        var decision = registry.Where(f => f.Read == AutomationFactRead.Decision).SelectMany(f => f.Readers).ToHashSet(StringComparer.Ordinal);
        var used = new HashSet<string>(StringComparer.Ordinal);

        void Step(string step, IEnumerable<MethodDeclarationSyntax> bodies, ISet<string> allowed)
        {
            foreach (var body in bodies)
                foreach (var read in reads.In(body, model))
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
        // Every member that reads anything is one of the steps (CheckOne, for diagnostics, gathers and judges one gate).
        // (The constructor only wires the services and delegates; what the delegates do is WriteGateWalk.KnownDelegates'.)
        foreach (var other in gate.Members.Where(m => m is not (ConstructorDeclarationSyntax or FieldDeclarationSyntax) && m is not MethodDeclarationSyntax { Identifier.ValueText: "Gather" or "StampOf" or "Check" or "CheckOne" } && !(m is MethodDeclarationSyntax d && DecisionMethods.Contains(d.Identifier.ValueText))))
            foreach (var read in reads.In(other, model))
                problems.Add(Member(other) + ": " + read.Name + " is read outside the check's steps (" + read.Line + ")");

        foreach (var fact in registry)
            foreach (var reader in fact.Readers)
            {
                var step = fact.Read == AutomationFactRead.Versioned ? "gather" : "decision";
                if (!used.Contains(step + ":" + reader) && !(reader == "AutomationWriteGate._config" && used.Contains("check:" + reader)))
                    problems.Add(fact.Id + ": " + reader + " is registered but the " + step + " never reads it");
            }

        // A person's gathered fact is read for the requester.
        var gather = methods.Single(m => m.Identifier.ValueText == "Gather");
        foreach (var fact in registry.Where(f => f.Read == AutomationFactRead.Versioned && f.Version != null && PerPerson.Contains(f.Version)))
            foreach (var read in reads.In(gather, model).Where(r => fact.Readers.Contains(r.Name)))
                if (!ForTheRequester(read, walk))
                    problems.Add(fact.Id + ": " + read.Name + " is read for someone other than the requester (" + read.Line + ")");

        problems.AddRange(StampProblems(walk, gate, model, reads, registry));
        return problems;
    }

    private static string Member(MemberDeclarationSyntax member) => member switch
    {
        MethodDeclarationSyntax m => m.Identifier.ValueText,
        PropertyDeclarationSyntax p => p.Identifier.ValueText,
        _ => member.Kind().ToString(),
    };

    // Every version source of a gathered fact: sampled into its own slot from its own sampler (a person's for the
    // requester), checked settled (but the configuration and generation, which are compared whole), and compared.
    private static IEnumerable<string> StampProblems(WriteGateWalk walk, ClassDeclarationSyntax gate, SemanticModel model, Reads reads, IReadOnlyList<AutomationFact> registry)
    {
        var stampOf = gate.Members.OfType<MethodDeclarationSyntax>().Single(m => m.Identifier.ValueText == "StampOf");
        var record = gate.DescendantNodes().OfType<RecordDeclarationSyntax>().Single(r => r.Identifier.ValueText == "Stamp");
        var slots = record.ParameterList!.Parameters.Select(p => p.Identifier.ValueText).ToList();
        var creation = stampOf.DescendantNodes().OfType<BaseObjectCreationExpressionSyntax>().Single(c => model.GetTypeInfo(c).Type?.Name == "Stamp");
        var args = creation.ArgumentList!.Arguments;
        var same = record.DescendantNodes().OfType<MethodDeclarationSyntax>().Single(m => m.Identifier.ValueText == "Same");
        var settled = record.DescendantNodes().OfType<PropertyDeclarationSyntax>().Single(p => p.Identifier.ValueText == "Settled");
        var compared = Compared(same, model);
        var checkedSettled = settled.DescendantNodes().OfType<InvocationExpressionSyntax>()
            .Where(c => model.GetSymbolInfo(c).Symbol is IMethodSymbol { Name: "Settled", ContainingType.Name: "FactVersion" } && c.ArgumentList.Arguments.Count == 1)
            .Select(c => model.GetSymbolInfo(c.ArgumentList.Arguments[0].Expression).Symbol?.Name).ToHashSet(StringComparer.Ordinal);
        var everywhere = reads.In(stampOf, model).Select(r => r.Name).Concat(Calls(stampOf, model)).ToHashSet(StringComparer.Ordinal);
        foreach (var source in registry.Where(f => f.Version != null).Select(f => f.Version!).Append("generation").Append("configuration").Distinct())
        {
            if (!Sampled.TryGetValue(source, out var how)) { yield return source + ": no known sampler"; continue; }
            var slot = slots.IndexOf(how.Slot);
            if (slot < 0 || slot >= args.Count) { yield return source + ": the stamp has no " + how.Slot + " slot"; continue; }
            var held = reads.In(args[slot].Expression, model).Select(r => r.Name).Concat(Calls(args[slot].Expression, model)).ToHashSet(StringComparer.Ordinal);
            if (!everywhere.Contains(how.Sampler)) yield return source + ": the stamp doesn't sample it (" + how.Sampler + ")";
            else if (!held.Contains(how.Sampler)) yield return source + ": the stamp's " + how.Slot + " slot isn't sampled from " + how.Sampler + " (" + args[slot] + ")";
            foreach (var wrong in Sampled.Where(o => o.Key != source && o.Value.Sampler != how.Sampler && held.Contains(o.Value.Sampler)))
                yield return source + ": the stamp's " + how.Slot + " slot holds " + wrong.Key + "'s sample (" + args[slot] + ")";
            if (PerPerson.Contains(source))
                foreach (var read in reads.In(args[slot].Expression, model).Where(r => r.Name == how.Sampler))
                    if (!ForTheRequester(read, walk)) yield return source + ": the stamp samples it for someone other than the requester (" + read.Line + ")";
            if (!compared.Contains(how.Slot)) yield return source + ": the stamp doesn't compare it (" + how.Slot + ")";
            if (source is not ("configuration" or "generation") && !checkedSettled.Contains(how.Slot)) yield return source + ": the stamp doesn't check it settled (" + how.Slot + ")";
        }
    }

    // The slots Same compares with the other stamp's (Slot == other.Slot, or ReferenceEquals(Slot, other.Slot)), by symbol.
    private static HashSet<string> Compared(MethodDeclarationSyntax same, SemanticModel model)
    {
        var other = same.ParameterList.Parameters.Single().Identifier.ValueText;
        var result = new HashSet<string>(StringComparer.Ordinal);
        bool Pair(ExpressionSyntax a, ExpressionSyntax b)
            => a is IdentifierNameSyntax && b is MemberAccessExpressionSyntax { Expression: IdentifierNameSyntax { Identifier.ValueText: var o } } && o == other
               && model.GetSymbolInfo(a).Symbol is IPropertySymbol pa && SymbolEqualityComparer.Default.Equals(pa, model.GetSymbolInfo(b).Symbol);
        foreach (var binary in same.DescendantNodes().OfType<BinaryExpressionSyntax>().Where(b => b.IsKind(SyntaxKind.EqualsExpression)))
            if (Pair(binary.Left, binary.Right) || Pair(binary.Right, binary.Left)) result.Add(model.GetSymbolInfo(binary.Left is IdentifierNameSyntax ? binary.Left : binary.Right).Symbol!.Name);
        foreach (var call in same.DescendantNodes().OfType<InvocationExpressionSyntax>().Where(c => c.ArgumentList.Arguments.Count == 2 && model.GetSymbolInfo(c).Symbol is IMethodSymbol { Name: "ReferenceEquals" }))
            if (Pair(call.ArgumentList.Arguments[0].Expression, call.ArgumentList.Arguments[1].Expression)) result.Add(model.GetSymbolInfo(call.ArgumentList.Arguments[0].Expression).Symbol!.Name);
        return result;
    }

    // Every method called under a node ("Type.Member"), for samplers that aren't service reads (JsonSerializer.Serialize).
    private static IEnumerable<string> Calls(SyntaxNode node, SemanticModel model)
        => node.DescendantNodesAndSelf().OfType<InvocationExpressionSyntax>().Select(c => model.GetSymbolInfo(c).Symbol).OfType<IMethodSymbol>().Select(m => m.ContainingType?.Name + "." + m.Name);

    // The read's person (its Guid argument) is the write's requester.
    private static bool ForTheRequester(Read read, WriteGateWalk walk)
    {
        if (read.Node is not InvocationExpressionSyntax call) return false;
        var flow = new SemanticFlow(walk);
        var people = call.ArgumentList.Arguments.Where(a => read.Model.GetTypeInfo(a.Expression).Type?.ToDisplayString() is "System.Guid" or "System.Guid?").ToList();
        return people.Count > 0 && people.All(a => flow.Roots(a.Expression, read.Model) is var roots && roots.Count > 0
            && roots.Any(r => r is IPropertySymbol { Name: "Requester", ContainingType.Name: "AutomationWrite" })
            && roots.All(r => r is IPropertySymbol { Name: "Requester", ContainingType.Name: "AutomationWrite" } or IParameterSymbol { Type.Name: "AutomationWrite" }));
    }

    // The fact reads under a node, by symbols.
    private sealed class Reads(WriteGateWalk walk, INamedTypeSymbol gate)
    {
        private readonly SemanticFlow _flow = new(walk);

        public IEnumerable<Read> In(SyntaxNode node, SemanticModel model)
        {
            foreach (var n in node.DescendantNodesAndSelf())
            {
                if (n is InvocationExpressionSyntax call)
                {
                    foreach (var read in Call(call, model)) yield return read;
                    continue;
                }

                // A property of a service (not a call: its invocation is classified above).
                if (n is not (MemberAccessExpressionSyntax or MemberBindingExpressionSyntax) || n.Parent is InvocationExpressionSyntax { Expression: var invoked } && invoked == n) continue;
                if (model.GetSymbolInfo(n).Symbol is IPropertySymbol property && Receiver((ExpressionSyntax)n) is { } owner && Service(owner, model))
                    yield return new Read(property.ContainingType.Name + "." + property.Name, n, model, Line(n));
            }
        }

        private IEnumerable<Read> Call(InvocationExpressionSyntax call, SemanticModel model)
        {
            var line = Line(call);
            if (model.GetSymbolInfo(call).Symbol is not IMethodSymbol symbol) yield break;
            // One of the check's delegates (through an alias, this. or .Invoke too).
            if (symbol.MethodKind == MethodKind.DelegateInvoke)
            {
                var target = call.Expression is MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Invoke", Expression: var d } ? d : call.Expression;
                foreach (var origin in _flow.Origins(target, model, GateMember))
                    if (origin.Symbol is IFieldSymbol field && GateMember(field) && field.Type.TypeKind == TypeKind.Delegate)
                        yield return new Read("AutomationWriteGate." + field.Name, call, model, line);
                yield break;
            }

            symbol = symbol.ReducedFrom ?? symbol;
            // The check's own methods: their bodies are classified as the steps they are (or reported outside them).
            if (SymbolEqualityComparer.Default.Equals(symbol.ContainingType, gate)) yield break;
            var name = symbol.ContainingType?.Name + "." + symbol.Name;
            if (Receiver(call.Expression) is { } receiver && Service(receiver, model))
                yield return new Read(name, call, model, line);
            else if (symbol.ContainingType?.Name == "PluginConfiguration" && !symbol.IsStatic)
                yield return new Read(name, call, model, line);
            else if (call.ArgumentList.Arguments.Any(a => Service(a.Expression, model)))
                yield return new Read(name, call, model, line);
        }

        // The receiver of a member access or binding (a?.b: a).
        private static ExpressionSyntax? Receiver(ExpressionSyntax expression) => expression switch
        {
            MemberAccessExpressionSyntax access => access.Expression,
            MemberBindingExpressionSyntax binding => binding.Ancestors().OfType<ConditionalAccessExpressionSyntax>().FirstOrDefault(c => c.WhenNotNull.Span.Contains(binding.Span))?.Expression,
            _ => null,
        };

        // A value of a service: a service-typed value, or one coming from a field the check holds (its services).
        private bool Service(ExpressionSyntax expression, SemanticModel model)
        {
            if (model.GetSymbolInfo(expression).Symbol is INamedTypeSymbol or INamespaceSymbol) return false;
            if (IsServiceType(model.GetTypeInfo(expression).Type)) return true;
            foreach (var origin in _flow.Origins(expression, model, GateMember))
                if (origin.Symbol is IFieldSymbol field && GateMember(field) && field.Type.TypeKind != TypeKind.Delegate || IsServiceType(OriginType(origin)))
                    return true;
            return false;
        }

        private bool GateMember(ISymbol symbol) => symbol is IFieldSymbol { IsStatic: false } field && SymbolEqualityComparer.Default.Equals(field.ContainingType, gate);

        private static ITypeSymbol? OriginType(SemanticFlow.Origin origin) => origin.Symbol switch
        {
            IFieldSymbol f => f.Type,
            IPropertySymbol p => p.Type,
            IParameterSymbol p => p.Type,
            ILocalSymbol l => l.Type,
            IMethodSymbol m => m.ReturnType,
            _ => null,
        };

        private static bool IsServiceType(ITypeSymbol? type)
        {
            if (type == null) return false;
            if (type is INamedTypeSymbol { IsGenericType: true, Name: "Nullable" } nullable) type = nullable.TypeArguments[0];
            return ServiceTypes.Contains(type.Name) || type.AllInterfaces.Any(i => ServiceTypes.Contains(i.Name)) || (type.BaseType is { } b && IsServiceType(b));
        }

        private static string Line(SyntaxNode node) => node.SyntaxTree.GetText().Lines[node.GetLocation().GetLineSpan().StartLinePosition.Line].ToString().Trim();
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
        // Round 9 (4a-security-r9-3): the same unregistered read through a local alias of the store,
        ["alias_read"] = ("if (!string.IsNullOrEmpty(w.Target) && _store != null) facts = facts with { Breaker = _store.Breaker(w.Target) };",
            "var store = _store;\n            if (!string.IsNullOrEmpty(w.Target) && _store != null && store != null) facts = facts with { Breaker = store.Breakers().FirstOrDefault() ?? _store.Breaker(w.Target) };",
            "gather: AutomationStore.Breakers reads a fact the registry doesn't list"),
        // through this._store,
        ["this_store_read"] = ("if (!string.IsNullOrEmpty(w.Target) && _store != null) facts = facts with { Breaker = _store.Breaker(w.Target) };",
            "if (!string.IsNullOrEmpty(w.Target) && this._store != null) facts = facts with { Breaker = this._store.Breakers().FirstOrDefault() ?? _store.Breaker(w.Target) };",
            "gather: AutomationStore.Breakers reads a fact the registry doesn't list"),
        // through a helper method that returns the store,
        ["helper_method_read"] = ("if (!string.IsNullOrEmpty(w.Target) && _store != null) facts = facts with { Breaker = _store.Breaker(w.Target) };",
            "if (!string.IsNullOrEmpty(w.Target) && _store != null) facts = facts with { Breaker = Peek()!.Breakers().FirstOrDefault() ?? _store.Breaker(w.Target) };",
            "gather: AutomationStore.Breakers reads a fact the registry doesn't list"),
        // and through a helper property.
        ["helper_property_read"] = ("if (!string.IsNullOrEmpty(w.Target) && _store != null) facts = facts with { Breaker = _store.Breaker(w.Target) };",
            "if (!string.IsNullOrEmpty(w.Target) && _store != null) facts = facts with { Breaker = Store!.Breakers().FirstOrDefault() ?? _store.Breaker(w.Target) };",
            "gather: AutomationStore.Breakers reads a fact the registry doesn't list"),
        // A registered reader called through an alias in the wrong step is still in the wrong step.
        ["alias_read_in_the_decision"] = ("_eligibility.Trusted(w.Requester)", "_eligibility.Trusted(w.Requester) && Eligibility()!.Granted(w.Requester)", "decision: AutomationEligibility.Granted is read here, not in its registered step"),
        // A person's fact read for someone else (its version is sampled for the requester).
        ["admin_read_for_someone_else"] = ("Admin = _policy.IsAdmin(w.Requester)", "Admin = _policy.IsAdmin(w.Approver ?? Guid.Empty)", "jellyfin_admin: IRequestPolicy.IsAdmin is read for someone other than the requester"),
        // A person's version sampled for someone else.
        ["permission_version_for_someone_else"] = ("_policy?.PermissionVersion(write.Requester) ?? 0", "_policy?.PermissionVersion(write.Approver ?? Guid.Empty) ?? 0", "jellyfin_user: the stamp samples it for someone other than the requester"),
        // A slot filled from another source's sampler: the Jellyfin slot holds the consent version (r9's wrong-source class, in the stamp).
        ["wrong_sampler_in_a_slot"] = ("_policy?.PermissionVersion(write.Requester) ?? 0", "_consents?.Version(write.Requester) ?? 0", "jellyfin_user: the stamp doesn't sample it"),
        ["swapped_slots"] = ("_consents?.Version(write.Requester) ?? 0,\n                _policy?.PermissionVersion(write.Requester) ?? 0", "_policy?.PermissionVersion(write.Requester) ?? 0,\n                _consents?.Version(write.Requester) ?? 0", "person_settings: the stamp's Person slot isn't sampled from IAutomationConsents.Version"),
        // A version no longer checked settled.
        ["permission_version_not_checked_settled"] = ("FactVersion.Settled(Jellyfin) && ", "", "jellyfin_user: the stamp doesn't check it settled"),
    };

    // Helpers a plant uses, added to the gate too.
    private static readonly Dictionary<string, string> Helpers = new(StringComparer.Ordinal)
    {
        ["helper_method_read"] = "private AutomationStore? Peek() => _store;",
        ["helper_property_read"] = "private AutomationStore? Store => this._store;",
        ["alias_read_in_the_decision"] = "private AutomationEligibility? Eligibility() { var e = _eligibility; return e; }",
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
            source = source[..at] + planted + source[(at + text.Length)..];
            if (Helpers.TryGetValue(plant, out var helper))
            {
                const string anchor = "private static bool Engine(AutomationWrite write, PluginConfiguration config)";
                source = source.Replace(anchor, helper + "\n        " + anchor, StringComparison.Ordinal);
            }
            return source;
        });
        var errors = walk.Errors(GateFile);
        if (errors.Count > 0) throw new Xunit.Sdk.XunitException(string.Join("\n", errors));
        var problems = Problems(walk, AutomationFacts.All);
        Assert.True(problems.Any(p => p.Contains(reported, StringComparison.Ordinal)), plant + ": expected \"" + reported + "\" in:\n" + string.Join("\n", problems));
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
