using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace JE.Tests;

/// <summary>
/// 4f round 9 (4f-r8-1, D53): the notify path's source rules, checked by Roslyn symbols over the plugin's source (the same
/// compilation as <see cref="ListGateWalk"/>). The notify path is every member of NotifyDispatcher, NotificationService and
/// the gate's own types (NotifyFinal.cs). The rules:
/// <list type="bullet">
/// <item>Nothing handed in: no method, local function, lambda or constructor in the notify path takes a
/// <c>PluginConfiguration</c> or <c>NotifyPrefs</c> (the household-link formatters excepted), and none keeps one in a field.</item>
/// <item>Nothing carried: a configuration, preferences or verdict (NotifyFinal) held in a local of an async function is never
/// used after an await that follows it (nor in a loop that awaits, nor captured by a nested function).</item>
/// <item>One gate: <c>NotifyDispatcher.Final</c> is synchronous and takes only the alert (its identifiers); its helpers read
/// through a ref struct, which the compiler won't let live across an await; a verdict is made only inside the gate.</item>
/// <item>No await between the gate and its action: every action on an alert (a send, a delivery postponed, suppressed or
/// settled, a summary's members settled, a bell row and its deliveries, a wait added, retried, taken or dropped, a notice or
/// a batch consumed) comes after a <c>Final</c> call in the same function with no await in between (a settle may follow
/// the network send it settles; a method handed a verdict acts on it, and its callers are checked instead).</item>
/// <item>One verdict → effect table (4f round 10): a verdict is acted on only through <c>NotifyFinal.Effect</c>, its one table
/// (Off = leave it as it is, Wait = postpone, Refuse = suppress, Send = act), in a switch that names every effect; nothing reads
/// the verdict itself outside the gate; each switch's sections do only what their effect allows (a Leave section writes
/// nothing; a Postpone section neither suppresses nor acts; a Suppress section neither postpones nor acts, and suppresses
/// something unless its site says how the event is consumed; an Act section suppresses or postpones only after acting); every
/// verdict of the gate reaches such a switch.</item>
/// <item>Every alert carries its origin: each alert the notify path makes for the gate sets <c>Since</c> (when what it tells
/// happened), deliveries excepted (their alert was told when it was made).</item>
/// </list>
/// <see cref="AwaitSites"/> lists every await on the alert paths (followed from the rounds' entry points) for the
/// await-point model.
/// </summary>
internal sealed class NotifyGateWalk
{
    private const string Ns = "Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify.";
    private static readonly Lazy<NotifyGateWalk> _plugin = new(() => new NotifyGateWalk(ListGateWalk.Plugin.Source));

    private static readonly string[] Files = { "NotifyDispatcher.cs", "NotificationService.cs", "NotifyFinal.cs" };

    // The rounds' entry points the await-point model follows (what they await in these two types is followed in turn).
    private static readonly (string Type, string Method)[] Roots =
    {
        ("NotifyDispatcher", "RunOnceAsync"), ("NotificationService", "TickAsync"), ("NotificationService", "RemindAsync"), ("NotificationService", "SetFollowAsync"),
    };

    // The gate and the helpers it reads through (a verdict is made only in these).
    private static readonly HashSet<string> GateMethods = new(StringComparer.Ordinal) { "Final", "Outbound", "Display", "Tell", "Off", "Send", "Wait", "Refuse" };

    // The household-link formatters (they decide nothing; the plan calls them with the configuration the gate read).
    private static readonly HashSet<string> Formatters = new(StringComparer.Ordinal) { "ExternalLink", "SettingsLink" };

    private readonly CSharpCompilation _compilation;
    private readonly Dictionary<SyntaxTree, SemanticModel> _models = new();

    private NotifyGateWalk(CSharpCompilation compilation) => _compilation = compilation;

    /// <summary>The plugin as it is on disk.</summary>
    internal static NotifyGateWalk Plugin => _plugin.Value;

    /// <summary>The same plugin with one notify file's text changed (a planted bypass).</summary>
    internal NotifyGateWalk With(string file, Func<string, string> change)
    {
        var tree = _compilation.SyntaxTrees.Single(t => Path.GetFileName(t.FilePath) == file);
        var before = tree.GetText().ToString();
        var after = change(before);
        Assert.NotEqual(before, after);
        var changed = CSharpSyntaxTree.ParseText(SourceText.From(after), (CSharpParseOptions)tree.Options, tree.FilePath);
        return new NotifyGateWalk(_compilation.ReplaceSyntaxTree(tree, changed));
    }

    /// <summary>Compile errors in the notify path's files (symbols are only followed reliably in code that compiles).</summary>
    internal List<string> Errors()
        => Scope().SelectMany(s => s.Model.GetDiagnostics()).Where(d => d.Severity == DiagnosticSeverity.Error && d.Id != "CS0619").Select(d => d.ToString()).ToList();

    private INamedTypeSymbol? Type(string name) => _compilation.GetTypeByMetadataName(name);

    private INamedTypeSymbol Dispatcher => Type(Ns + "NotifyDispatcher")!;

    private INamedTypeSymbol Service => Type(Ns + "NotificationService")!;

    private INamedTypeSymbol? Plan => Type(Ns + "NotifyFinal");

    private INamedTypeSymbol Config => Type("Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration")!;

    private INamedTypeSymbol Prefs => Type(Ns + "NotifyPrefs")!;

    // ── the rules ──────────────────────────────────────────────────────────

    /// <summary>Every rule over the notify path: what breaks one, one line each.</summary>
    internal List<string> Problems()
    {
        var problems = new List<string>();
        if (Plan == null) problems.Add("there is no final gate (NotifyFinal)");
        Signatures(problems);
        Carried(problems);
        Gate(problems);
        Actions(problems);
        Table(problems);
        Origins(problems);
        return problems;
    }

    private bool Watched(ITypeSymbol? type, bool plans)
    {
        if (type == null) return false;
        if (type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } nullable) type = nullable.TypeArguments[0];
        if (Is(type, Config) || Is(type, Prefs) || (plans && Plan != null && Is(type, Plan))) return true;
        if (type is INamedTypeSymbol named)
        {
            if (named.IsTupleType && named.TupleElements.Any(e => Watched(e.Type, plans))) return true;
            if (named.TypeArguments.Any(a => Watched(a, plans)) && !IsDelegate(named)) return true;
        }

        return type is IArrayTypeSymbol array && Watched(array.ElementType, plans);
    }

    private static bool IsDelegate(INamedTypeSymbol type) => type.TypeKind == TypeKind.Delegate;

    // E1 adds private bodies behind SeerrFacts scope forwarders. Treat a body as its owner only when every
    // reference is a direct invocation from that owner's scope. A new bypass caller invalidates this mapping.
    private readonly Dictionary<IMethodSymbol, string> _scopedOwners = new(SymbolEqualityComparer.Default);

    private string ScopedOwnerName(IMethodSymbol method)
    {
        if (_scopedOwners.TryGetValue(method, out var known)) return known;
        var result = method.Name;
        const string suffix = "FactsCore";
        if (method.DeclaredAccessibility == Accessibility.Private && method.Name.EndsWith(suffix, StringComparison.Ordinal))
        {
            var name = method.Name[..^suffix.Length];
            var wrappers = method.ContainingType.GetMembers(name).OfType<IMethodSymbol>().Where(w =>
                SymbolEqualityComparer.Default.Equals(w.ReturnType, method.ReturnType) && w.Parameters.Length == method.Parameters.Length &&
                w.Parameters.Zip(method.Parameters).All(p => SymbolEqualityComparer.Default.Equals(p.First.Type, p.Second.Type))).ToList();
            if (wrappers.Count == 1)
            {
                var wrapper = wrappers[0];
                var references = Scope().SelectMany(s => s.Tree.GetRoot().DescendantNodes().OfType<IdentifierNameSyntax>()
                    .Where(n => SymbolEqualityComparer.Default.Equals(s.Model.GetSymbolInfo(n).Symbol, method))
                    .Select(n => (Node: n, s.Model))).ToList();
                if (references.Count > 0 && references.All(r =>
                    r.Node.Parent is InvocationExpressionSyntax call && call.Expression == r.Node &&
                    SymbolEqualityComparer.Default.Equals(Member(r.Model, call), wrapper) &&
                    call.Ancestors().OfType<InvocationExpressionSyntax>().Any(scope =>
                        r.Model.GetSymbolInfo(scope).Symbol is IMethodSymbol scopeMethod &&
                        scopeMethod.ContainingType.ToDisplayString() == "Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts" &&
                        scopeMethod.Name is "Compose" or "ComposeAsync" or "BackgroundAsync")))
                    result = name;
            }
        }
        _scopedOwners[method] = result;
        return result;
    }


    // Nothing handed in: no parameter (or field) carries a configuration or preferences into the notify path.
    private void Signatures(List<string> problems)
    {
        foreach (var (tree, model) in Scope())
        {
            foreach (var parameter in tree.GetRoot().DescendantNodes().OfType<ParameterSyntax>())
            {
                if (model.GetDeclaredSymbol(parameter) is not IParameterSymbol symbol || !Watched(symbol.Type, plans: false)) continue;
                if (symbol.ContainingSymbol is IMethodSymbol { IsStatic: true } m && Formatters.Contains(m.Name)) continue;
                // The verdict's own makers (called only by the gate: see Gate) and the gate's reading.
                if (Is(symbol.ContainingSymbol.ContainingType, Plan) || symbol.ContainingSymbol.ContainingType?.Name == "GateRead") continue;
                problems.Add($"a {symbol.Type.Name} handed in as '{symbol.Name}' of {symbol.ContainingSymbol.Name} at {Where(parameter)}");
            }

            foreach (var field in tree.GetRoot().DescendantNodes().OfType<FieldDeclarationSyntax>())
            {
                foreach (var variable in field.Declaration.Variables)
                {
                    if (model.GetDeclaredSymbol(variable) is IFieldSymbol f && Watched(f.Type, plans: true) && !Is(f.ContainingType, Plan))
                        problems.Add($"a {f.Type.Name} kept in the field {f.Name} at {Where(variable)}");
                }
            }

            foreach (var property in tree.GetRoot().DescendantNodes().OfType<PropertyDeclarationSyntax>())
            {
                if (model.GetDeclaredSymbol(property) is IPropertySymbol p && Watched(p.Type, plans: true) && !Is(p.ContainingType, Plan) && p.ContainingType.Name != "GateRead")
                    problems.Add($"a {p.Type.Name} kept in the property {p.Name} at {Where(property)}");
            }
        }
    }

    // Nothing carried: a configuration, preferences or verdict in a local of an async function is used only before the next
    // await (a verdict may be handed to the network send it is awaited with).
    private void Carried(List<string> problems)
    {
        foreach (var (tree, model) in Scope())
        {
            foreach (var function in tree.GetRoot().DescendantNodes().Where(IsFunction).Where(f => IsAsync(f)))
            {
                var body = Body(function);
                if (body == null) continue;
                foreach (var declared in body.DescendantNodes().Where(n => Function(n) == body && n is VariableDeclaratorSyntax or SingleVariableDesignationSyntax or ForEachStatementSyntax))
                {
                    if (model.GetDeclaredSymbol(declared) is not ILocalSymbol local || !Watched(local.Type, plans: true)) continue;
                    var from = declared is ForEachStatementSyntax loop ? loop.Statement.SpanStart : declared.Span.End;
                    foreach (var use in body.DescendantNodes().OfType<IdentifierNameSyntax>().Where(i => i.Identifier.ValueText == local.Name && i.SpanStart >= from))
                    {
                        if (!SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(use).Symbol, local)) continue;
                        // A synchronous lambda handed straight to a call (a transaction's work) runs where it is handed over;
                        // any other nested function may run later.
                        SyntaxNode at = use;
                        while (Function(at) != body && Function(at) is { Parent: AnonymousFunctionExpressionSyntax { AsyncKeyword.RawKind: 0, Parent: ArgumentSyntax } lambda }) at = lambda;
                        if (Function(at) != body)
                        {
                            problems.Add($"the {local.Type.Name} '{local.Name}' captured by a nested function at {Where(use)}");
                            continue;
                        }

                        if (WaitsBetween(body, from, at, network: false) is { } wait)
                        {
                            problems.Add($"the {local.Type.Name} '{local.Name}' used after an await ({Where(wait)}) at {Where(use)}: {Line(use)}");
                            continue;
                        }

                        // Used again in a later turn of a loop that awaits.
                        var turn = at.Ancestors().TakeWhile(a => a != body).FirstOrDefault(a => a is ForEachStatementSyntax or ForStatementSyntax or WhileStatementSyntax or DoStatementSyntax
                            && !a.Span.Contains(declared.Span) && a.DescendantNodes(n => !Skip(n, at)).Any(Waits));
                        if (turn != null) problems.Add($"the {local.Type.Name} '{local.Name}' used in a loop that awaits ({Where(turn)}) at {Where(use)}");
                    }
                }
            }
        }
    }

    // The gate: synchronous, handed only the alert, read through a ref struct, and the only maker of verdicts.
    private void Gate(List<string> problems)
    {
        if (Plan is not { } plan) return;
        var finals = Dispatcher.GetMembers("Final").OfType<IMethodSymbol>().ToList();
        if (finals.Count != 1)
        {
            problems.Add($"NotifyDispatcher has {finals.Count} Final methods");
            return;
        }

        var final = finals[0];
        if (final.IsAsync || !Is(final.ReturnType, plan) || final.Parameters.Length != 1 || final.Parameters[0].Type.Name != "NotifyAlert")
            problems.Add("NotifyDispatcher.Final isn't a synchronous NotifyFinal Final(NotifyAlert)");
        var reads = Dispatcher.GetTypeMembers("GateRead").SingleOrDefault();
        if (reads is not { IsRefLikeType: true }) problems.Add("the gate's reading (GateRead) isn't a ref struct");
        foreach (var helper in Dispatcher.GetMembers().OfType<IMethodSymbol>().Where(m => m.Parameters.Any(p => reads != null && Is(p.Type, reads))))
        {
            if (helper.IsAsync) problems.Add($"{helper.Name} reads the gate's reading and is async");
        }

        foreach (var (tree, model) in Scope())
        {
            foreach (var made in tree.GetRoot().DescendantNodes().OfType<BaseObjectCreationExpressionSyntax>())
            {
                if (!Is(model.GetTypeInfo(made).Type, plan)) continue;
                var where = Member(model, made);
                if (!(Is(where?.ContainingType, plan) || (Is(where?.ContainingType, Dispatcher) && where is IMethodSymbol m && GateMethods.Contains(ScopedOwnerName(m)))))
                    problems.Add($"a verdict made outside the gate at {Where(made)}");
            }

            foreach (var call in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (model.GetSymbolInfo(call).Symbol is not IMethodSymbol { IsStatic: true } m || !Is(m.ContainingType, plan) || !Is(m.ReturnType, plan)) continue;
                var where = Member(model, call);
                if (!(Is(where?.ContainingType, Dispatcher) && where is IMethodSymbol g && GateMethods.Contains(ScopedOwnerName(g))))
                    problems.Add($"a verdict made outside the gate at {Where(call)}");
            }
        }
    }

    // The actions on an alert (a send, a delivery settled, postponed or suppressed, a bell row and its deliveries, a wait added
    // or retried), and the settles that may follow the network send they settle. Consuming what tells nothing (a notice that
    // isn't an alert, a malformed batch) needs no verdict; every consumption that ends an alert is the model's to check.
    private string? ActionKind(IMethodSymbol m)
    {
        var type = m.ContainingType?.Name;
        if (Is(m.ContainingType, Dispatcher) && m.Name is "SendAsync" or "Settle") return m.Name == "Settle" ? "settle" : "send";
        if (type == "ReadyNativeChannel" && m.Name == "SendAsync") return "send";
        if (type == "NotifyStore" && m.Name is "Finish") return "settle";
        if (type == "NotifyStore" && m.Name is "Suppress") return "settle-or-act";
        if (type == "NotifyStore" && m.Name is "Postpone" or "RetryAlertWait" or "Add") return "act";
        if (type == "NotifyTransaction" && m.Name is "Add" or "AddAlertWait") return "act";
        if (Is(m.ContainingType, Service) && m.Name is "Notify" or "NotifyAll") return "act";
        if ((InScope(m.ContainingType)) && TakesPlan(m)) return "act";
        return null;
    }

    // NotifyDispatcher, NotificationService and the types nested in them.
    private bool InScope(INamedTypeSymbol? type)
    {
        for (var t = type; t != null; t = t.ContainingType)
        {
            if (Is(t, Dispatcher) || Is(t, Service)) return true;
        }

        return false;
    }

    private bool TakesPlan(IMethodSymbol m) => Plan != null && m.Parameters.Any(p => Watched(p.Type, plans: true) && !Watched(p.Type, plans: false));

    /// <summary>The action sites the last <see cref="Problems"/> checked ("Name at File:line").</summary>
    internal List<string> Checked { get; } = new();

    private void Actions(List<string> problems)
    {
        var counted = 0;
        Checked.Clear();
        foreach (var (tree, model) in Scope())
        {
            foreach (var call in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (model.GetSymbolInfo(call).Symbol is not IMethodSymbol m || ActionKind(m.OriginalDefinition) is not { } kind) continue;
                // A method handed a verdict acts on it (its callers are checked); the gate's own types are its implementation.
                var owner = Member(model, call) as IMethodSymbol;
                if (owner == null || !InScope(owner.ContainingType)) continue;
                // An action inside an action (a settle's own writes, a verdict's helper) is checked at the action's call sites.
                if (TakesPlan(owner) || ActionKind(owner) != null || (GateMethods.Contains(owner.Name) && Is(owner.ContainingType, Dispatcher))) continue;
                counted++;
                Checked.Add(m.Name + " at " + Where(call));
                // A synchronous lambda (a transaction's work, a notification's "handled" step) runs where it is handed over.
                SyntaxNode at = call;
                while (Function(at) is { Parent: AnonymousFunctionExpressionSyntax { AsyncKeyword.RawKind: 0 } lambda }) at = lambda;
                var body = Function(at);
                if (body == null)
                {
                    problems.Add($"an action outside a function at {Where(call)}");
                    continue;
                }

                var gate = body.DescendantNodes(n => !(n != body && IsFunction(n))).OfType<InvocationExpressionSyntax>()
                    .Where(i => i.Span.End <= at.SpanStart && IsFinal(model, i)).OrderBy(i => i.SpanStart).LastOrDefault();
                if (gate == null)
                {
                    problems.Add($"{m.Name} with no Final before it at {Where(call)}: {Line(call)}");
                    continue;
                }

                if (WaitsBetween(body, gate.Span.End, at, network: kind is "settle" or "settle-or-act", model) is { } wait)
                    problems.Add($"{m.Name} at {Where(call)} waits after the Final at {Where(gate)}: {Where(wait)}: {Line(wait)}");
                if (call.ArgumentList.DescendantNodes().Any(Waits)) problems.Add($"{m.Name} awaits in its arguments at {Where(call)}");
            }
        }

        if (counted < 15) problems.Add($"only {counted} actions found");
    }

    private bool IsFinal(SemanticModel model, InvocationExpressionSyntax call)
        => model.GetSymbolInfo(call).Symbol is IMethodSymbol { Name: "Final" } m && Is(m.ContainingType, Dispatcher);

    // The first await on the way from `from` to `target` in `body` (code that returns before it, nested functions and the
    // target's own ancestors are not on the way); with `network`, an await of a network send is allowed (a settle after it).
    private SyntaxNode? WaitsBetween(SyntaxNode body, int from, SyntaxNode target, bool network, SemanticModel? model = null)
    {
        var containers = target.AncestorsAndSelf().ToHashSet();
        foreach (var node in body.DescendantNodes(n => !Skip(n, target)))
        {
            if (node.SpanStart < from || node.SpanStart >= target.SpanStart || containers.Contains(node) || Skip(node, target) || !Waits(node)) continue;
            if (network && model != null && node is AwaitExpressionSyntax awaited && NetworkSend(model, awaited)) continue;
            return node;
        }

        return null;
    }

    private bool NetworkSend(SemanticModel model, AwaitExpressionSyntax awaited)
        => Awaited(awaited.Expression) is { } call && model.GetSymbolInfo(call).Symbol is IMethodSymbol { Name: "SendAsync" } m
           && (Is(m.ContainingType, Dispatcher) || m.ContainingType?.Name == "ReadyNativeChannel");

    // ── one verdict → effect table (4f round 10) ───────────────────────────

    private INamedTypeSymbol? EffectType => Type(Ns + "NotifyEffect");

    // The table: each verdict and the one effect it has at every action site.
    private static readonly Dictionary<string, string> TableRows = new(StringComparer.Ordinal)
    {
        ["Off"] = "Leave", ["Wait"] = "Postpone", ["Refuse"] = "Suppress", ["Send"] = "Act",
    };

    // Sites whose refusal is consumed with the event itself, outside the switch: the reason a Suppress section there writes
    // nothing. A collector (its Act section only gathers the verdicts) consumes the event with the rows it makes.
    internal static readonly Dictionary<string, string> ConsumedElsewhere = new(StringComparer.Ordinal)
    {
        ["ScanRequests"] = "the Seerr change is marked seen with the rest of the list after the loop",
        ["AdminChecksAsync"] = "a Needs-attention row is a condition the next check observes again; nothing is queued for it",
        ["SendTest"] = "a test: nothing is queued, nothing to consume",
        ["TrySendTest"] = "a test: nothing is queued, nothing to consume",
    };

    /// <summary>The switches over the effect the last <see cref="Problems"/> checked ("Method at File:line").</summary>
    internal List<string> EffectSites { get; } = new();

    // What an action call does, for the effect it may appear under: act (a send, a settle, a bell row), postpone, suppress, or
    // another write (consuming a notice, a batch, a mark); null for anything else.
    private string? EffectClass(IMethodSymbol m)
    {
        var type = m.ContainingType?.Name;
        if (Is(m.ContainingType, Dispatcher) && m.Name is "SendAsync" or "Settle") return "act";
        if (type == "ReadyNativeChannel" && m.Name == "SendAsync") return "act";
        if (Is(m.ContainingType, Service) && m.Name is "Notify" or "NotifyAll" or "Add" or "Announce") return "act";
        if (type is "NotifyStore" or "NotifyTransaction" && m.Name is "Add" or "Finish") return "act";
        if (type is "NotifyStore" or "NotifyTransaction" && m.Name is "Postpone" or "AddAlertWait" or "RetryAlertWait") return "postpone";
        if (Is(m.ContainingType, Service) && m.Name == "WaitBatch") return "postpone";
        if (type is "NotifyStore" && m.Name is "Suppress" or "DropAlertWait") return "suppress";
        if (Is(m.ContainingType, Service) && m.Name == "DropBatch") return "suppress";
        if (type == "NotifyTransaction") return "write";
        if (type == "NotifyStore" && m.Name is "InTransaction" or "TryMark" or "ClaimMark" or "SetBatch" or "DeleteBatch" or "SavePrefs") return "write";
        return null;
    }

    private void Table(List<string> problems)
    {
        EffectSites.Clear();
        if (Plan is not { } plan) return;
        if (EffectType is not { } effect)
        {
            problems.Add("there is no verdict → effect table (NotifyEffect)");
            return;
        }

        // The table itself: one switch, each verdict to its effect.
        var of = plan.GetMembers("EffectOf").OfType<IMethodSymbol>().SingleOrDefault();
        var arms = of?.DeclaringSyntaxReferences.SelectMany(r => r.GetSyntax().DescendantNodes().OfType<SwitchExpressionArmSyntax>()).ToList() ?? new();
        var rows = arms.Where(a => a.Pattern is ConstantPatternSyntax).ToDictionary(
            a => ((ConstantPatternSyntax)a.Pattern).Expression is MemberAccessExpressionSyntax v ? v.Name.Identifier.ValueText : "?",
            a => a.Expression is MemberAccessExpressionSyntax e ? e.Name.Identifier.ValueText : "?");
        foreach (var (verdict, wanted) in TableRows)
        {
            if (!rows.TryGetValue(verdict, out var got)) problems.Add($"the table (NotifyFinal.EffectOf) has no row for {verdict}");
            else if (got != wanted) problems.Add($"the table maps {verdict} to {got}, not {wanted}");
        }

        if (plan.GetMembers("Effect").OfType<IPropertySymbol>().SingleOrDefault() is not { } effectProperty)
        {
            problems.Add("a verdict has no Effect (NotifyFinal.Effect)");
            return;
        }

        foreach (var (tree, model) in Scope())
        {
            var root = tree.GetRoot();
            // Nothing reads the verdict itself outside the gate; the effect is read only to switch over it.
            foreach (var access in root.DescendantNodes().OfType<MemberAccessExpressionSyntax>())
            {
                if (model.GetSymbolInfo(access).Symbol is not IPropertySymbol p || !Is(p.ContainingType, plan)) continue;
                var where = Member(model, access);
                var inGate = Is(where?.ContainingType, plan) || (Is(where?.ContainingType, Dispatcher) && where is IMethodSymbol g && GateMethods.Contains(ScopedOwnerName(g)));
                if (p.Name is "Verdict" or "Sends" && !inGate)
                    problems.Add($"the verdict read directly (not through the table) at {Where(access)}: {Line(access)}");
                if (SymbolEqualityComparer.Default.Equals(p, effectProperty) && !(access.Parent is SwitchStatementSyntax s && s.Expression == access))
                    problems.Add($"the effect read outside a switch over it at {Where(access)}: {Line(access)}");
            }

            foreach (var swtch in root.DescendantNodes().OfType<SwitchStatementSyntax>())
            {
                if (!Is(model.GetTypeInfo(swtch.Expression).Type, effect)) continue;
                var owner = Member(model, swtch);
                var site = owner is IMethodSymbol method ? ScopedOwnerName(method) : owner?.Name ?? "?";
                EffectSites.Add(site + " at " + Where(swtch));
                // A method handed a verdict (it acts on it for its callers) isn't where the event is consumed: its callers are.
                var deciding = swtch.Expression is MemberAccessExpressionSyntax m && SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(m).Symbol, effectProperty)
                               && !(owner is IMethodSymbol handed && TakesPlan(handed));
                var named = new HashSet<string>(StringComparer.Ordinal);
                var collector = swtch.Sections.Any(s => Labels(s).Contains("Act") && s.DescendantNodes().OfType<InvocationExpressionSyntax>().Any(c => Collects(model, c, plan)));
                foreach (var section in swtch.Sections)
                {
                    if (section.Labels.Any(l => l is DefaultSwitchLabelSyntax)) problems.Add($"a switch over the effect lumps effects in a default at {Where(section)}");
                    var labels = Labels(section);
                    if (labels.Count != section.Labels.Count(l => l is not DefaultSwitchLabelSyntax)) problems.Add($"a switch over the effect with a label that isn't one effect at {Where(section)}");
                    named.UnionWith(labels);
                    var calls = section.DescendantNodes().OfType<InvocationExpressionSyntax>()
                        .Select(c => (Call: c, Class: model.GetSymbolInfo(c).Symbol is IMethodSymbol cm ? EffectClass(cm.OriginalDefinition) : null))
                        .Where(c => c.Class != null).OrderBy(c => c.Call.SpanStart).ToList();
                    string Calls(IEnumerable<(InvocationExpressionSyntax Call, string? Class)> list) => string.Join(", ", list.Select(c => Name(c.Call) + " (" + c.Class + ")"));
                    if (labels.Contains("Leave") && calls.Count > 0)
                        problems.Add($"Leave at {Where(section)} ({site}) does {Calls(calls)}: nothing may be done while notifications are off");
                    if (labels.Contains("Postpone") && calls.Where(c => c.Class is "act" or "suppress").ToList() is { Count: > 0 } wrongP)
                        problems.Add($"Postpone at {Where(section)} ({site}) does {Calls(wrongP)}: a wait is postponed, never ended or told");
                    if (labels.Contains("Suppress") && calls.Where(c => c.Class is "act" or "postpone").ToList() is { Count: > 0 } wrongS)
                        problems.Add($"Suppress at {Where(section)} ({site}) does {Calls(wrongS)}: a refusal ends it, never told or held");
                    if (labels.Contains("Act"))
                    {
                        var firstAct = calls.FirstOrDefault(c => c.Class == "act").Call?.SpanStart ?? int.MaxValue;
                        if (calls.Where(c => c.Class is "suppress" or "postpone" && c.Call.SpanStart < firstAct).ToList() is { Count: > 0 } wrongA)
                            problems.Add($"Act at {Where(section)} ({site}) does {Calls(wrongA)} before acting");
                    }

                    if (deciding && labels.Contains("Suppress") && !collector && !calls.Any(c => c.Class is "suppress" or "write") && !ConsumedElsewhere.ContainsKey(site))
                        problems.Add($"Suppress at {Where(section)} ({site}) suppresses nothing (and the site doesn't say how its event is consumed)");
                }

                foreach (var missing in TableRows.Values.Where(e => !named.Contains(e)))
                    problems.Add($"a switch over the effect at {Where(swtch)} ({site}) doesn't name {missing}");
            }

            // Every verdict of the gate is acted on through the table: switched over, or handed to a method that acts on it
            // (and switches over it).
            foreach (var call in root.DescendantNodes().OfType<InvocationExpressionSyntax>().Where(c => IsFinal(model, c)))
            {
                var where = Member(model, call);
                if (Is(where?.ContainingType, plan) || (Is(where?.ContainingType, Dispatcher) && where is IMethodSymbol g && GateMethods.Contains(ScopedOwnerName(g)))) continue;
                if (call.Parent is not EqualsValueClauseSyntax { Parent: VariableDeclaratorSyntax declarator } || model.GetDeclaredSymbol(declarator) is not ILocalSymbol local)
                {
                    problems.Add($"a verdict of the gate not kept to be acted on at {Where(call)}: {Line(call)}");
                    continue;
                }

                var scope = declarator.Ancestors().First(a => a is BlockSyntax);
                var uses = scope.DescendantNodes().OfType<IdentifierNameSyntax>().Where(i => i.Identifier.ValueText == local.Name && SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(i).Symbol, local)).ToList();
                var acted = uses.Any(u => (u.Parent is MemberAccessExpressionSyntax ma && ma.Expression == u && ma.Parent is SwitchStatementSyntax && ma.Name.Identifier.ValueText == "Effect")
                                          || (u.Parent is ArgumentSyntax { Parent: ArgumentListSyntax { Parent: InvocationExpressionSyntax inv } } && model.GetSymbolInfo(inv).Symbol is IMethodSymbol target && TakesPlan(target) && InScope(target.ContainingType)));
                if (!acted) problems.Add($"a verdict of the gate never acted on through the table at {Where(call)}: {Line(call)}");
            }
        }
    }

    // The effects a switch section's labels name (NotifyEffect.X).
    private static List<string> Labels(SwitchSectionSyntax section)
        => section.Labels.OfType<CaseSwitchLabelSyntax>().Select(l => l.Value is MemberAccessExpressionSyntax { Expression: IdentifierNameSyntax { Identifier.ValueText: "NotifyEffect" } } v ? v.Name.Identifier.ValueText : "?").ToList();

    // Gathering verdicts to make their rows later (a collector's Act section).
    private static bool Collects(SemanticModel model, InvocationExpressionSyntax call, INamedTypeSymbol plan)
        => model.GetSymbolInfo(call).Symbol is IMethodSymbol { Name: "Add" } m && m.ContainingType is { IsGenericType: true } list
           && list.TypeArguments.Any(t => Is(t, plan));

    private static string Name(InvocationExpressionSyntax call) => call.Expression switch
    {
        MemberAccessExpressionSyntax m => m.Name.Identifier.ValueText,
        IdentifierNameSyntax i => i.Identifier.ValueText,
        _ => call.Expression.ToString(),
    };

    // Every alert the notify path makes for the gate carries its origin (Since); a delivery's alert (NotifyAlert.Of) excepted.
    private void Origins(List<string> problems)
    {
        var alertType = Type(Ns + "NotifyAlert");
        if (alertType == null) return;
        var counted = 0;
        foreach (var (tree, model) in Scope())
        {
            foreach (var made in tree.GetRoot().DescendantNodes().OfType<BaseObjectCreationExpressionSyntax>())
            {
                if (!Is(model.GetTypeInfo(made).Type, alertType)) continue;
                var where = Member(model, made);
                if (Is(where?.ContainingType, alertType) && where?.Name == "Of") continue;
                counted++;
                var since = made.Initializer?.Expressions.OfType<AssignmentExpressionSyntax>().FirstOrDefault(a => a.Left is IdentifierNameSyntax { Identifier.ValueText: "Since" });
                if (since == null)
                {
                    problems.Add($"an alert made with no origin (Since) at {Where(made)} ({where?.Name})");
                    continue;
                }

                // Its origin is a time, never "no limit".
                if (model.GetTypeInfo(since.Right).Type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } || since.Right is LiteralExpressionSyntax)
                    problems.Add($"an alert whose origin may be missing (Since = {since.Right}) at {Where(made)} ({where?.Name})");
            }
        }

        if (counted < 2) problems.Add($"only {counted} alerts made");
    }

    // ── the await sites of the alert paths ─────────────────────────────────

    /// <summary>
    /// Every await on the alert paths, as "Method:Callee" (the callee qualified by its type where one method awaits two of the
    /// same name, numbered where it awaits the same callee twice), following the awaited methods of NotifyDispatcher and
    /// NotificationService from the rounds' entry points.
    /// </summary>
    internal HashSet<string> AwaitSites()
    {
        var sites = new HashSet<string>(StringComparer.Ordinal);
        var seen = new HashSet<IMethodSymbol>(SymbolEqualityComparer.Default);
        var pending = new Stack<IMethodSymbol>();
        foreach (var (type, method) in Roots)
        {
            var owner = type == "NotifyDispatcher" ? Dispatcher : Service;
            foreach (var m in owner.GetMembers(method).OfType<IMethodSymbol>()) pending.Push(m);
        }

        while (pending.Count > 0)
        {
            var method = pending.Pop();
            if (!seen.Add(method)) continue;
            foreach (var reference in method.DeclaringSyntaxReferences)
            {
                var declaration = reference.GetSyntax();
                var model = Model(declaration.SyntaxTree);
                var awaits = declaration.DescendantNodes().OfType<AwaitExpressionSyntax>()
                    .Where(a => !a.Ancestors().TakeWhile(x => x != declaration).Any(x => x is AnonymousFunctionExpressionSyntax))
                    .Select(a => (Await: a, Call: Awaited(a.Expression))).ToList();
                var named = awaits.Select(a => (a.Await, Symbol: a.Call == null ? null : model.GetSymbolInfo(a.Call).Symbol as IMethodSymbol, a.Call)).ToList();
                string Callee(IMethodSymbol? m, InvocationExpressionSyntax? call)
                {
                    if (m == null) return call?.Expression.ToString() ?? "?";
                    if (m.Name == "Invoke" && call?.Expression is IdentifierNameSyntax field) return field.Identifier.ValueText;
                    var clash = named.Any(o => o.Symbol != null && o.Symbol.Name == m.Name && !SymbolEqualityComparer.Default.Equals(o.Symbol.ContainingType, m.ContainingType));
                    return clash ? m.ContainingType.Name + "." + m.Name : m.Name;
                }

                var labels = named.Select(n => method.Name + ":" + Callee(n.Symbol, n.Call)).ToList();
                for (var i = 0; i < labels.Count; i++)
                {
                    var same = labels.Count(l => l == labels[i]);
                    var nth = labels.Take(i + 1).Count(l => l == labels[i]);
                    sites.Add(same > 1 ? labels[i] + "#" + nth.ToString(System.Globalization.CultureInfo.InvariantCulture) : labels[i]);
                    if (named[i].Symbol is { } callee && (Is(callee.ContainingType, Dispatcher) || Is(callee.ContainingType, Service))) pending.Push(callee.OriginalDefinition);
                }
            }
        }

        return sites;
    }

    // The call an awaited expression awaits (through ConfigureAwait and parentheses).
    private static InvocationExpressionSyntax? Awaited(ExpressionSyntax expression)
    {
        while (true)
        {
            switch (expression)
            {
                case ParenthesizedExpressionSyntax p:
                    expression = p.Expression;
                    continue;
                case InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name.Identifier.ValueText: "ConfigureAwait" or "WaitAsync" } member } when member.Expression is InvocationExpressionSyntax inner:
                    expression = inner;
                    continue;
                case InvocationExpressionSyntax call:
                    return call;
                default:
                    return null;
            }
        }
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private IEnumerable<(SyntaxTree Tree, SemanticModel Model)> Scope()
        => _compilation.SyntaxTrees.Where(t => Files.Contains(Path.GetFileName(t.FilePath)) && t.FilePath.Contains("Notify", StringComparison.Ordinal)).Select(t => (t, Model(t)));

    private SemanticModel Model(SyntaxTree tree)
    {
        if (!_models.TryGetValue(tree, out var model)) _models[tree] = model = _compilation.GetSemanticModel(tree);
        return model;
    }

    private static bool Is(ITypeSymbol? type, INamedTypeSymbol? wanted) => wanted != null && SymbolEqualityComparer.Default.Equals(type?.OriginalDefinition, wanted);

    private static bool IsFunction(SyntaxNode node) => node is BaseMethodDeclarationSyntax or AccessorDeclarationSyntax or LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax;

    private static bool IsAsync(SyntaxNode function) => function switch
    {
        MethodDeclarationSyntax m => m.Modifiers.Any(SyntaxKind.AsyncKeyword),
        LocalFunctionStatementSyntax l => l.Modifiers.Any(SyntaxKind.AsyncKeyword),
        AnonymousFunctionExpressionSyntax f => f.AsyncKeyword.IsKind(SyntaxKind.AsyncKeyword),
        _ => false,
    };

    private static SyntaxNode? Body(SyntaxNode function) => function switch
    {
        BaseMethodDeclarationSyntax m => (SyntaxNode?)m.Body ?? m.ExpressionBody,
        AccessorDeclarationSyntax a => (SyntaxNode?)a.Body ?? a.ExpressionBody,
        LocalFunctionStatementSyntax l => (SyntaxNode?)l.Body ?? l.ExpressionBody,
        AnonymousFunctionExpressionSyntax f => f.Body,
        _ => null,
    };

    // The body of the function a node runs in: a method, accessor, constructor, local function or lambda.
    private static SyntaxNode? Function(SyntaxNode node)
        => node.Ancestors().FirstOrDefault(IsFunction) is { } owner ? Body(owner) : null;

    // The method, accessor, constructor or property a node is in.
    private static ISymbol? Member(SemanticModel model, SyntaxNode node)
    {
        var declaration = node.Ancestors().FirstOrDefault(a => a is BaseMethodDeclarationSyntax or AccessorDeclarationSyntax or PropertyDeclarationSyntax or FieldDeclarationSyntax);
        return declaration switch
        {
            FieldDeclarationSyntax field => model.GetDeclaredSymbol(field.Declaration.Variables[0]),
            { } member => model.GetDeclaredSymbol(member),
            _ => null,
        };
    }

    private static bool Waits(SyntaxNode node) => node switch
    {
        AwaitExpressionSyntax => true,
        UsingStatementSyntax u => u.AwaitKeyword.IsKind(SyntaxKind.AwaitKeyword),
        LocalDeclarationStatementSyntax l => l.AwaitKeyword.IsKind(SyntaxKind.AwaitKeyword),
        CommonForEachStatementSyntax f => f.AwaitKeyword.IsKind(SyntaxKind.AwaitKeyword),
        _ => false,
    };

    // Not on the way to the target: a return or throw (or a block ending in one) that doesn't hold it, and a nested function's
    // body (it runs when called).
    private static bool Skip(SyntaxNode node, SyntaxNode target)
        => (!node.Span.Contains(target.Span) && (node is ReturnStatementSyntax or ThrowStatementSyntax or ThrowExpressionSyntax
                || (node is BlockSyntax { Statements: [.., ReturnStatementSyntax or ThrowStatementSyntax] } block && !block.DescendantNodes().Any(d => d is BreakStatementSyntax or ContinueStatementSyntax or GotoStatementSyntax))))
            || (node is LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax && !node.Span.Contains(target.Span));

    private static string Where(SyntaxNode node)
    {
        var span = node.GetLocation().GetLineSpan();
        return Path.GetFileName(span.Path) + ":" + (span.StartLinePosition.Line + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    private static string Line(SyntaxNode node) => node.SyntaxTree.GetText().Lines[node.GetLocation().GetLineSpan().StartLinePosition.Line].ToString().Trim();
}
