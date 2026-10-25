using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace JE.Tests;

/// <summary>
/// Defence in depth since review round 6 (D41): the guarantee for automatic writes is the transport check
/// (AutomationTransportHandler), which runs inside the HTTP transport whatever waits before it. This walk still checks
/// that the write sites' own gates are asked with nothing waiting before the send.
///
/// 4a review round 5: it compiles the plugin's own source and follows the code from a gate call to the HTTP send that
/// carries the write, by syntax and symbols rather than by line or text: everything evaluated after the gate and before
/// the send in the gate's method (the write's own statement and its arguments included), then, down the call that
/// carries the write, everything before the send in each plugin method on the way (ArrClient.SendCoreAsync,
/// SendOnceAsync, SeerrBackend.RawAsync…), and the whole body of every plugin method, constructor or property called on
/// the way (interface and virtual calls: every implementation in the plugin, explicit ones included). An await
/// (<c>await</c>, <c>await using</c>, <c>await foreach</c>) or a blocking wait (Wait, Result, GetResult, Sleep, a
/// reader/writer lock's Enter…, a BlockingCollection's Add/Take) anywhere there is reported. So is a gate that doesn't
/// always run before the write, and a loop that could send the write again after a wait without asking the gate again.
/// Not on the way: code that leaves before the write (<c>return</c>, <c>throw</c>). An async method that is only started
/// runs up to its first await: that part is walked. A call through a delegate can't be followed: it is reported
/// anywhere on the way, unless it is one of <see cref="KnownDelegates"/>, and for those every value the field is given
/// (its initialiser, each assignment, and for a constructor parameter what each creation passes) is walked.
///
/// 4a review round 7: <see cref="AfterDecision"/> walks what follows the transport check's final decision (from it to the
/// hand-off to the inner handler, and the decision itself) in a strict mode: besides the waits above, any database call
/// (AcquireDatabase, SQLite), lock statement, Monitor call or file I/O there is reported too. Facts are gathered before
/// that decision; nothing that can wait may follow it.
/// </summary>
internal sealed class WriteGateWalk
{
    /// <summary>Delegates a write may call on its way: what they do is known, and they don't wait.</summary>
    internal static readonly Dictionary<string, string> KnownDelegates = new(StringComparer.Ordinal)
    {
        ["_http"] = "the HTTP client factory (IHttpClientFactory.CreateClient)",
        ["_now"] = "the clock",
        ["_config"] = "the live configuration (an administrator's save replaces it)",
        ["_secrets"] = "the secrets store's version (a FactVersion sample)",
    };

    private static readonly Lazy<WriteGateWalk> _plugin = new(() => new WriteGateWalk(Load()));

    /// <summary>The plugin as it is on disk.</summary>
    internal static WriteGateWalk Plugin => _plugin.Value;

    internal CSharpCompilation Compilation => _compilation;

    private readonly CSharpCompilation _compilation;
    private readonly Dictionary<SyntaxTree, SemanticModel> _models = new();
    private readonly Dictionary<ISymbol, bool> _leads = new(SymbolEqualityComparer.Default);
    private List<INamedTypeSymbol>? _types;
    private readonly bool _strict;

    private WriteGateWalk(CSharpCompilation compilation, bool strict = false)
    {
        _compilation = compilation;
        _strict = strict;
    }

    private static CSharpCompilation Load()
    {
        var root = Path.Combine(IntegrationAutoRequestLedgerTests.Root(), "Jellyfin.Plugin.JellyfinEnhanced");
        // The test runs on the runtime of the target it was built for: .NET 10 is the Jellyfin 12 build, .NET 9 the 10.11 one.
        var options = new CSharpParseOptions(LanguageVersion.Latest, preprocessorSymbols: new[] { Environment.Version.Major >= 10 ? "JF12" : "JF10" });
        var trees = Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
            .Where(f => !f[root.Length..].Split(Path.DirectorySeparatorChar).Any(d => d is "obj" or "bin"))
            .OrderBy(f => f, StringComparer.Ordinal)
            .Select(f => CSharpSyntaxTree.ParseText(SourceText.From(File.ReadAllText(f)), options, f))
            .Append(CSharpSyntaxTree.ParseText("global using System; global using System.Collections.Generic; global using System.IO; global using System.Linq; global using System.Net.Http; global using System.Threading; global using System.Threading.Tasks;", options, "ImplicitUsings.cs"));
        // The runtime's own assemblies, then everything the tests were built with (Jellyfin, ASP.NET Core, SkiaSharp…),
        // except the plugin and the tests themselves.
        var paths = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator).Concat(Directory.EnumerateFiles(AppContext.BaseDirectory, "*.dll")))
        {
            var name = Path.GetFileNameWithoutExtension(path);
            if (name is "Jellyfin.Plugin.JellyfinEnhanced" or "JE.Tests" || paths.ContainsKey(name)) continue;
            try { AssemblyName.GetAssemblyName(path); } catch (BadImageFormatException) { continue; }
            paths[name] = path;
        }

        return CSharpCompilation.Create("Jellyfin.Plugin.JellyfinEnhanced", trees, paths.Values.Select(p => MetadataReference.CreateFromFile(p)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable, allowUnsafe: true));
    }

    /// <summary>The same plugin with one file's text changed (a planted bypass).</summary>
    internal WriteGateWalk With(string relative, Func<string, string> change)
    {
        var tree = Tree(relative);
        var changed = CSharpSyntaxTree.ParseText(SourceText.From(change(tree.GetText().ToString())), (CSharpParseOptions)tree.Options, tree.FilePath);
        return new WriteGateWalk(_compilation.ReplaceSyntaxTree(tree, changed));
    }

    internal string Text(string relative) => Tree(relative).GetText().ToString();

    /// <summary>
    /// Every HttpClient the plugin gets, by symbols: each <c>IHttpClientFactory.CreateClient</c> call with the client's
    /// name ("" for the default one; null when the name isn't a constant), and each HttpClient it constructs itself
    /// (name "new").
    /// </summary>
    internal List<(string Where, string? Name)> HttpClients()
    {
        var found = new List<(string Where, string? Name)>();
        foreach (var tree in _compilation.SyntaxTrees)
        {
            var model = Model(tree);
            foreach (var node in tree.GetRoot().DescendantNodes())
            {
                if (node is not BaseObjectCreationExpressionSyntax
                    && node is not InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name.Identifier.Text: "CreateClient" } or IdentifierNameSyntax { Identifier.Text: "CreateClient" } }) continue;
                // Enumerate consumers of the acquisition boundary. Its factory/forwarding
                // construction is independently executed by TmdbEgressTests for every pipeline.
                var caller = model.GetEnclosingSymbol(node.SpanStart) as IMethodSymbol;
                if (caller?.GetDocumentationCommentId() is "M:Jellyfin.Plugin.JellyfinEnhanced.Services.PluginHttp.CreateClient(System.Net.Http.IHttpClientFactory,System.String)"
                    or "M:Jellyfin.Plugin.JellyfinEnhanced.Services.PluginHttp.CheckedClient(System.Net.Http.HttpClient)") continue;
                if (node is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name.Identifier.Text: "CreateClient" } or IdentifierNameSyntax { Identifier.Text: "CreateClient" } } call
                    && model.GetSymbolInfo(call).Symbol is IMethodSymbol method)
                {
                    var declared = (method.ReducedFrom ?? method).ContainingType.ToDisplayString();
                    if (declared == "Jellyfin.Plugin.JellyfinEnhanced.Services.PluginHttp")
                    {
                        var name = call.ArgumentList.Arguments.Count < 2 ? Jellyfin.Plugin.JellyfinEnhanced.Services.PluginHttp.DefaultClient
                            : model.GetConstantValue(call.ArgumentList.Arguments[1].Expression) is { HasValue: true, Value: string value } ? value : null;
                        found.Add((Where(call), name));
                    }
                    else if (declared == "System.Net.Http.HttpClientFactoryExtensions") found.Add((Where(call), string.Empty));
                    else if (declared == "System.Net.Http.IHttpClientFactory")
                        found.Add((Where(call), call.ArgumentList.Arguments.Count == 1 && model.GetConstantValue(call.ArgumentList.Arguments[0].Expression) is { HasValue: true, Value: string name } ? name : null));
                }
                else if (node is BaseObjectCreationExpressionSyntax created && (node is ImplicitObjectCreationExpressionSyntax || created.ToString().Contains("HttpClient", StringComparison.Ordinal))
                    && model.GetTypeInfo(created).Type?.ToDisplayString() == "System.Net.Http.HttpClient")
                    found.Add((Where(created), "new"));
            }
        }
        return found;
    }

    /// <summary>
    /// Compile errors, in one file or in the whole plugin: symbols are only followed reliably in code that compiles. Not
    /// CS0619 (a member marked obsolete-as-error, still resolved): the tests' folder holds SkiaSharp's runtime assembly,
    /// and this compiler picks an overload of SKCanvas.SetMatrix that the build's newer one doesn't.
    /// </summary>
    internal List<string> Errors(string? relative = null)
        => (relative == null ? _compilation.GetDiagnostics() : Model(Tree(relative)).GetDiagnostics())
            .Where(d => d.Severity == DiagnosticSeverity.Error && d.Id != "CS0619").Select(d => d.ToString()).ToList();

    /// <summary>Every source file of the plugin, with its semantic model (round 8's fact registry and writer scans).</summary>
    internal IEnumerable<(SyntaxTree Tree, SemanticModel Model)> Sources()
        => _compilation.SyntaxTrees.Where(t => t.FilePath != "ImplicitUsings.cs").Select(t => (t, Model(t)));

    /// <summary>One source file of the plugin, with its semantic model.</summary>
    internal (SyntaxTree Tree, SemanticModel Model) Source(string relative)
    {
        var tree = Tree(relative);
        return (tree, Model(tree));
    }

    /// <summary>The semantic model of one of the plugin's trees.</summary>
    internal SemanticModel ModelOf(SyntaxTree tree) => Model(tree);

    private Dictionary<string, List<(SimpleNameSyntax Name, SyntaxTree Tree)>>? _names;

    /// <summary>
    /// Every place <paramref name="member"/> is named in the plugin (by symbol): the whole expression it is part of
    /// (<c>a.B</c>, <c>a?.B</c>), or the call when it is called.
    /// </summary>
    internal IEnumerable<(SyntaxNode Use, SemanticModel Model)> References(ISymbol member)
    {
        _names ??= _compilation.SyntaxTrees.Where(t => t.FilePath != "ImplicitUsings.cs")
            .SelectMany(t => t.GetRoot().DescendantNodes().OfType<SimpleNameSyntax>().Select(n => (Name: n, Tree: t)))
            .GroupBy(n => n.Name.Identifier.ValueText, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);
        if (!_names.TryGetValue(member.Name, out var names)) yield break;
        var target = member.OriginalDefinition;
        foreach (var (name, tree) in names)
        {
            var model = Model(tree);
            var info = model.GetSymbolInfo(name);
            var symbol = info.Symbol ?? info.CandidateSymbols.FirstOrDefault();
            if (symbol is IMethodSymbol { ReducedFrom: { } reduced }) symbol = reduced;
            if (symbol == null || !SymbolEqualityComparer.Default.Equals(symbol.OriginalDefinition, target)) continue;
            SyntaxNode use = name;
            while (use.Parent is MemberAccessExpressionSyntax or MemberBindingExpressionSyntax && use.Parent is not InvocationExpressionSyntax) use = use.Parent;
            if (use.Parent is InvocationExpressionSyntax invocation && invocation.Expression == use) use = invocation;
            else if (use.Parent is ConditionalAccessExpressionSyntax { WhenNotNull: var whenNotNull } access && whenNotNull == use) use = access;
            yield return (use, model);
        }
    }

    private SyntaxTree Tree(string relative)
    {
        var suffix = Path.DirectorySeparatorChar + relative.Replace('/', Path.DirectorySeparatorChar);
        return _compilation.SyntaxTrees.Single(t => t.FilePath.EndsWith(suffix, StringComparison.Ordinal));
    }

    private SemanticModel Model(SyntaxTree tree)
    {
        if (!_models.TryGetValue(tree, out var model)) _models[tree] = model = _compilation.GetSemanticModel(tree);
        return model;
    }

    /// <summary>
    /// From the last <paramref name="gate"/> call before the write named by <paramref name="write"/> (text in the write's
    /// statement, once in the file), in the same method, down to the HTTP send that carries the write.
    /// <paramref name="writeExit"/> names the condition that makes a write leave a retry loop before its next attempt.
    /// </summary>
    internal List<string> GateToSend(string relative, string write, string gate, string? writeExit = null)
        => Walk(relative, Unique(relative, write), gate, toSend: true, writeExit);

    /// <inheritdoc cref="GateToSend(string, string, string, string?)"/>
    internal List<string> GateToSend(string relative, int write, string gate, string? writeExit = null)
        => Walk(relative, write, gate, toSend: true, writeExit);

    /// <summary>From the last <paramref name="gate"/> call to the call starting with <paramref name="call"/> (itself not followed).</summary>
    internal List<string> GateToCall(string relative, string call, string gate)
        => Walk(relative, Unique(relative, call), gate, toSend: false, null);

    /// <summary>
    /// For a gate whose caller sends as soon as it says yes (the Direct client's <c>proceed</c>): from the last
    /// <paramref name="gate"/> call before each <c>return true</c> of the function holding <paramref name="inside"/> (text
    /// there, once in the file) to that return.
    /// </summary>
    internal List<string> GateToReturn(string relative, string inside, string gate)
    {
        var problems = new List<string>();
        var tree = Tree(relative);
        var model = Model(tree);
        var body = Function(tree.GetRoot().FindToken(Unique(relative, inside)).Parent!);
        var yes = body?.DescendantNodes().OfType<ReturnStatementSyntax>().Where(r => r.Expression is LiteralExpressionSyntax { RawKind: (int)SyntaxKind.TrueLiteralExpression } && Function(r) == body).ToList();
        if (body == null || yes is not { Count: > 0 }) { problems.Add(relative + ": no return true in the function holding " + inside); return problems; }
        foreach (var target in yes)
            if (Asked(body, gate, target, problems) is { } asked)
                Between(model, body, asked.Span.End, target, Where(asked) + " → " + Where(target) + " (back to the send)", problems);
        return problems;
    }

    /// <summary>
    /// After a final decision (round 7): from the statement holding the end of <paramref name="at"/> (text there, once in
    /// the file; itself included when <paramref name="included"/>, else from the statement after it) to the end of its function,
    /// and everything the plugin code called there runs, nothing may wait, read or write the database, take a lock or
    /// touch a file. A refusal (a throw, or a block ending in one) never hands the request on: it isn't walked.
    /// </summary>
    internal List<string> AfterDecision(string relative, string at, bool included)
    {
        var problems = new List<string>();
        var strict = new WriteGateWalk(_compilation, strict: true);
        var tree = strict.Tree(relative);
        var model = strict.Model(tree);
        var statement = tree.GetRoot().FindToken(Unique(relative, at) + at.Length - 1).Parent!.FirstAncestorOrSelf<StatementSyntax>()!;
        if (Function(statement) is not { } body) { problems.Add(relative + ": " + at + " isn't inside a method"); return problems; }
        var start = included ? statement.SpanStart : statement.Span.End;
        var path = Where(statement) + " (after the final decision)";
        var seen = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
        foreach (var node in body.DescendantNodes(n => !Refusal(n) && !Skip(n, null)).Where(n => n.SpanStart >= start && !Refusal(n) && !Skip(n, null)))
            strict.Visit(model, node, path, problems, seen);
        return problems;

        static bool Refusal(SyntaxNode n) => n is ThrowStatementSyntax or ThrowExpressionSyntax || n is BlockSyntax { Statements: [.., ThrowStatementSyntax] };
    }

    private int Unique(string relative, string text)
    {
        var source = Text(relative);
        var at = source.IndexOf(text, StringComparison.Ordinal);
        Assert.True(at >= 0 && source.IndexOf(text, at + 1, StringComparison.Ordinal) < 0, relative + ": \"" + text + "\" must be there once");
        return at;
    }

    private List<string> Walk(string relative, int position, string gate, bool toSend, string? writeExit)
    {
        var problems = new List<string>();
        var tree = Tree(relative);
        var model = Model(tree);
        var at = tree.GetRoot().FindToken(position).Parent!;
        var body = Function(at);
        if (body == null) { problems.Add(relative + ": the write isn't inside a method"); return problems; }

        var calls = body.DescendantNodes().OfType<InvocationExpressionSyntax>().Where(i => Function(i) == body);
        var target = toSend
            ? calls.Where(i => (i.Span.Contains(position) || i.SpanStart >= position) && Leads(Symbol(model, i))).OrderBy(i => i.SpanStart).ThenBy(i => i.Span.Length).FirstOrDefault()
            : calls.Where(i => i.SpanStart == position || i.Expression.SpanStart == position).OrderBy(i => i.Span.Length).FirstOrDefault();
        if (target == null) { problems.Add(Where(at) + ": no " + (toSend ? "HTTP send" : "call") + " found for this write"); return problems; }
        if (Asked(body, gate, target, problems) is not { } asked) return problems;
        var path = Where(asked) + " → " + Where(target);
        Between(model, body, asked.Span.End, target, path, problems);
        // A loop around the write (but not the gate) sends it again after the rest of the loop body, without the gate.
        foreach (var loop in target.Ancestors().TakeWhile(a => a != body).Where(IsLoop).Where(l => !l.Span.Contains(asked.Span)))
            Again(model, loop, target, writeExit, path, problems);
        if (toSend) Down(model, target, path, problems, new HashSet<ISymbol>(SymbolEqualityComparer.Default));
        return problems;
    }

    // The last gate call before the write. It must always run before it: its statement sits in a block that holds the
    // write (so not in a branch, nor in a loop the write isn't in), and within that statement it isn't skipped by a
    // short-circuit (&&, ||, ??, ?:, ?.), except when what is tested first is whether the gate itself is there
    // (`proceed != null && !proceed()`: a write with no gate to ask is a deliberate one).
    private static ExpressionSyntax? Asked(SyntaxNode body, string gate, SyntaxNode target, List<string> problems)
    {
        var asked = body.DescendantNodes().OfType<ExpressionSyntax>()
            .Where(e => e is InvocationExpressionSyntax or ConditionalAccessExpressionSyntax && e.ToString() == gate && Function(e) == body && e.Span.End <= target.SpanStart)
            .OrderBy(e => e.SpanStart).LastOrDefault();
        if (asked == null) { problems.Add(Where(target) + ": no " + gate + " before the write"); return null; }
        var statement = asked.FirstAncestorOrSelf<StatementSyntax>()!;
        var own = gate.Split('(', '?')[0];
        var skippable = asked.Ancestors().TakeWhile(a => a != statement).Any(a => a switch
        {
            BinaryExpressionSyntax b when b.Kind() is SyntaxKind.LogicalAndExpression or SyntaxKind.LogicalOrExpression or SyntaxKind.CoalesceExpression
                => b.Right.Span.Contains(asked.Span) && b.Left.ToString() != own + " != null",
            ConditionalExpressionSyntax c => !c.Condition.Span.Contains(asked.Span),
            ConditionalAccessExpressionSyntax c => c.WhenNotNull.Span.Contains(asked.Span),
            _ => false,
        });
        if (skippable || statement.Parent is not BlockSyntax block || !block.Span.Contains(target.Span))
            problems.Add(Where(asked) + ": " + gate + " doesn't always run before the write at " + Where(target));
        return asked;
    }

    // What runs between a point in a function and a call in it: every node starting after the point and before the call
    // that isn't the call's own container (the await on the write itself), the call's receiver and its arguments.
    private void Between(SemanticModel model, SyntaxNode body, int from, SyntaxNode target, string path, List<string> problems)
    {
        var containers = target.Ancestors().ToHashSet();
        var nodes = body.DescendantNodes(n => !Skip(n, target))
            .Where(n => n.SpanStart >= from && n.SpanStart < target.SpanStart && !containers.Contains(n) && !Skip(n, target));
        if (target is InvocationExpressionSyntax call)
            nodes = nodes.Concat(call.ArgumentList.DescendantNodesAndSelf())
                .Concat(call.Expression is MemberAccessExpressionSyntax member ? member.Expression.DescendantNodesAndSelf() : Enumerable.Empty<SyntaxNode>());
        var seen = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
        foreach (var node in nodes) Visit(model, node, path, problems, seen);
    }

    // The rest of a loop after the write (and its condition and step) runs before the loop sends the write again. A write
    // that always leaves the loop first (writeExit: an `if (… || !idempotent || …) return …;` right after it) never repeats.
    private void Again(SemanticModel model, SyntaxNode loop, InvocationExpressionSyntax target, string? writeExit, string path, List<string> problems)
    {
        var seen = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
        foreach (var node in loop.DescendantNodes(n => !Skip(n, target)).Where(n => !n.Span.Contains(target.Span) && !target.Span.Contains(n.Span) && !Skip(n, target)))
        {
            if (writeExit != null && node is IfStatementSyntax exit && exit.SpanStart > target.Span.End && exit.Statement is ReturnStatementSyntax or BlockSyntax { Statements: [ReturnStatementSyntax] }
                && exit.Condition.ToString().Split("||").Any(part => part.Trim() == writeExit)
                && exit.Parent == target.FirstAncestorOrSelf<StatementSyntax>()!.Parent)
                return;
            Visit(model, node, path + " (the loop sends the write again)", problems, seen);
        }
    }

    // Down the call that carries the write: in the called plugin method, everything before its own send, then further down.
    private void Down(SemanticModel model, InvocationExpressionSyntax call, string path, List<string> problems, HashSet<ISymbol> done)
    {
        var symbol = Symbol(model, call);
        if (symbol == null || IsHttpSend(symbol)) return;
        foreach (var method in Implementations(symbol))
        {
            if (!done.Add(method)) continue;
            foreach (var declaration in method.DeclaringSyntaxReferences.Select(r => r.GetSyntax()))
            {
                var inner = Model(declaration.SyntaxTree);
                var body = BodyOf(declaration);
                if (body == null) continue;
                var sends = body.DescendantNodes().OfType<InvocationExpressionSyntax>().Where(i => Function(i) == body && Leads(Symbol(inner, i))).ToList();
                foreach (var send in sends)
                {
                    var here = path + " → " + Where(send);
                    Between(inner, body, body.SpanStart, send, here, problems);
                    foreach (var loop in send.Ancestors().TakeWhile(a => a != body).Where(IsLoop))
                        Again(inner, loop, send, null, here, problems);
                    Down(inner, send, here, problems, done);
                }
            }
        }
    }

    // One node on the way (onPath: not inside a method called from it): a wait is reported, and a plugin method,
    // constructor or property it uses is walked whole.
    private void Visit(SemanticModel model, SyntaxNode node, string path, List<string> problems, HashSet<ISymbol> seen, bool onPath = true)
    {
        if (Waits(model, node) is { } wait)
        {
            problems.Add(path + ": " + wait + " at " + Where(node) + ": " + Line(node));
            return;
        }

        ISymbol? used = node switch
        {
            InvocationExpressionSyntax i when i.Expression is IdentifierNameSyntax { Identifier.Text: "nameof" } => null,
            InvocationExpressionSyntax i => Symbol(model, i) is { } s ? s : Unresolved(i),
            BaseObjectCreationExpressionSyntax c => model.GetSymbolInfo(c).Symbol,
            IdentifierNameSyntax n when model.GetSymbolInfo(n).Symbol is IPropertySymbol p => p,
            // Method groups assigned to known delegate fields must be followed too (including local functions).
            IdentifierNameSyntax n when n.Parent is AssignmentExpressionSyntax or EqualsValueClauseSyntax
                && model.GetSymbolInfo(n).Symbol is IMethodSymbol method => method,
            _ => null,
        };
        if (used == null) return;
        if (used is IMethodSymbol { MethodKind: MethodKind.DelegateInvoke } && node is InvocationExpressionSyntax through)
        {
            var name = (through.Expression switch
            {
                MemberAccessExpressionSyntax { Name.Identifier.Text: "Invoke" } invoke => invoke.Expression,
                MemberBindingExpressionSyntax { Name.Identifier.Text: "Invoke" } when through.Parent is ConditionalAccessExpressionSyntax access => access.Expression,
                var called => called,
            }).ToString();
            if (!KnownDelegates.ContainsKey(name)) problems.Add(path + ": a call through a delegate the walk can't follow (" + name + ") at " + Where(node) + ": " + Line(node));
            // A known factory's name alone isn't evidence: inspect every initializer/assignment of its field.
            if (KnownDelegates.ContainsKey(name))
            {
                var receiver = through.Expression is MemberAccessExpressionSyntax invoke ? invoke.Expression : through.Expression;
                if (model.GetSymbolInfo(receiver).Symbol is IFieldSymbol field && seen.Add(field))
                {
                    foreach (var owner in field.ContainingType.DeclaringSyntaxReferences.Select(r => r.GetSyntax()))
                    {
                        var inner = Model(owner.SyntaxTree);
                        foreach (var assignment in owner.DescendantNodes().OfType<AssignmentExpressionSyntax>()
                            .Where(a => SymbolEqualityComparer.Default.Equals(inner.GetSymbolInfo(a.Left).Symbol, field)))
                        {
                            foreach (var part in assignment.Right.DescendantNodesAndSelf()) Visit(inner, part, path + " → factory assignment", problems, seen, onPath: false);
                            // Assigned from a constructor's parameter: what every creation passes for it.
                            if (inner.GetSymbolInfo(assignment.Right).Symbol is IParameterSymbol { ContainingSymbol: IMethodSymbol { MethodKind: MethodKind.Constructor } constructor } parameter)
                                foreach (var (argument, argumentModel) in Arguments(constructor, parameter))
                                    foreach (var part in argument.DescendantNodesAndSelf()) Visit(argumentModel, part, path + " → factory passed at " + Where(argument), problems, seen, onPath: false);
                        }
                    }
                    foreach (var declaration in field.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).OfType<VariableDeclaratorSyntax>())
                        if (declaration.Initializer is { } initializer)
                            foreach (var part in initializer.Value.DescendantNodesAndSelf()) Visit(Model(part.SyntaxTree), part, path + " → factory initializer", problems, seen, onPath: false);
                }
            }
            return;
        }

        // A base call runs the base member itself, never an override (framework code has none to walk).
        var members = node is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Expression: BaseExpressionSyntax } }
            ? (used.DeclaringSyntaxReferences.Length > 0 ? new[] { used.OriginalDefinition } : Array.Empty<ISymbol>())
            : Implementations(used);
        foreach (var member in members)
        {
            if (!seen.Add(member)) continue;
            // A record's primary constructor is declared by the whole type: only its parameters run.
            // An unawaited async method still runs its synchronous prefix before returning its task.
            var asyncMethod = member is IMethodSymbol { IsAsync: true };
            foreach (var declaration in member.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).Select(d => d is TypeDeclarationSyntax t ? t.ParameterList! : d).Where(d => d != null))
            {
                var inner = Model(declaration.SyntaxTree);
                // An unawaited async method executes its synchronous prefix on this thread.
                var firstAwait = asyncMethod ? declaration.DescendantNodes().OfType<AwaitExpressionSyntax>().Select(a => a.SpanStart).DefaultIfEmpty(int.MaxValue).Min() : int.MaxValue;
                foreach (var part in declaration.DescendantNodes(n => n == declaration || !Skip(n, null)).Where(n => !Skip(n, null) && n.SpanStart < firstAwait))
                    Visit(inner, part, path + " → " + member.ContainingType.Name + "." + member.Name, problems, seen, onPath: false);
            }
        }

        ISymbol? Unresolved(InvocationExpressionSyntax i)
        {
            problems.Add(path + ": a call the walk can't resolve at " + Where(i) + ": " + Line(i));
            return null;
        }
    }

    // What every creation in the plugin passes for one constructor parameter (by position or by name). Only files naming
    // the constructor's type are searched: a target-typed new() needs its type named nearby (a field, return or local).
    private IEnumerable<(ExpressionSyntax Argument, SemanticModel Model)> Arguments(IMethodSymbol constructor, IParameterSymbol parameter)
    {
        foreach (var tree in _compilation.SyntaxTrees.Where(t => t.GetText().ToString().Contains(constructor.ContainingType.Name, StringComparison.Ordinal)))
        {
            var model = Model(tree);
            foreach (var creation in tree.GetRoot().DescendantNodes().OfType<BaseObjectCreationExpressionSyntax>())
            {
                if (creation.ArgumentList is not { } list || !SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(creation).Symbol, constructor)) continue;
                var argument = list.Arguments.FirstOrDefault(a => a.NameColon?.Name.Identifier.Text == parameter.Name)
                    ?? (parameter.Ordinal < list.Arguments.Count && list.Arguments[parameter.Ordinal].NameColon == null ? list.Arguments[parameter.Ordinal] : null);
                if (argument != null) yield return (argument.Expression, model);
            }
        }
    }

    private string? Waits(SemanticModel model, SyntaxNode node)
    {
        switch (node)
        {
            case LockStatementSyntax when _strict: return "a lock";
            case AwaitExpressionSyntax: return "an await";
            case UsingStatementSyntax u when u.AwaitKeyword.IsKind(SyntaxKind.AwaitKeyword): return "an await using";
            case LocalDeclarationStatementSyntax l when l.AwaitKeyword.IsKind(SyntaxKind.AwaitKeyword): return "an await using";
            case CommonForEachStatementSyntax f when f.AwaitKeyword.IsKind(SyntaxKind.AwaitKeyword): return "an await foreach";
        }

        var symbol = node switch
        {
            InvocationExpressionSyntax i => model.GetSymbolInfo(i).Symbol,
            MemberAccessExpressionSyntax { Name.Identifier.Text: "Result" } m => model.GetSymbolInfo(m).Symbol,
            BaseObjectCreationExpressionSyntax c when _strict => model.GetSymbolInfo(c).Symbol,
            _ => null,
        };
        if (symbol == null) return null;
        if (_strict && Blocks(symbol) is { } blocks) return blocks;
        if (symbol.ContainingType?.OriginalDefinition.ToDisplayString() == "System.Collections.Concurrent.BlockingCollection<T>"
            && symbol.Name is "Add" or "Take" or "TryAdd" or "TryTake" or "GetConsumingEnumerable")
            return "a blocking wait (BlockingCollection." + symbol.Name + ")";
        var space = symbol.ContainingNamespace?.ToDisplayString();
        return space is "System.Threading" or "System.Threading.Tasks" or "System.Runtime.CompilerServices"
            && symbol.Name is "Wait" or "WaitAll" or "WaitAny" or "WaitOne" or "Sleep" or "SpinUntil" or "Join" or "GetResult" or "Result"
                or "EnterReadLock" or "EnterWriteLock" or "EnterUpgradeableReadLock" or "TryEnterReadLock" or "TryEnterWriteLock" or "TryEnterUpgradeableReadLock"
            ? "a blocking wait (" + symbol.ContainingType!.Name + "." + symbol.Name + ")"
            : null;
    }

    // Strict (after a final decision): database calls, Monitor and file I/O, besides the waits.
    private static string? Blocks(ISymbol symbol)
    {
        var type = symbol.ContainingType?.ToDisplayString() ?? string.Empty;
        var space = symbol.ContainingNamespace?.ToDisplayString() ?? string.Empty;
        if (type == "Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.AcquireDatabase" && symbol.Name is "Read" or "Write" or "WriteIf" or "WriteAutomation" or "Snapshot" or "ReplaceWith")
            return "a database call (AcquireDatabase." + symbol.Name + ")";
        if (space.StartsWith("Microsoft.Data.Sqlite", StringComparison.Ordinal)) return "a database call (" + symbol.ContainingType!.Name + "." + symbol.Name + ")";
        if (type == "System.Threading.Monitor" && symbol.Name is not ("Exit" or "Pulse" or "PulseAll" or "IsEntered")) return "a lock (Monitor." + symbol.Name + ")";
        if (space == "System.IO" && symbol.ContainingType!.Name is "File" or "Directory" or "FileInfo" or "DirectoryInfo" or "FileSystemInfo" or "FileStream" or "StreamReader" or "StreamWriter" or "DriveInfo" or "RandomAccess")
            return "file I/O (" + symbol.ContainingType.Name + "." + symbol.Name + ")";
        return null;
    }

    // Does this call send an HTTP request, itself or through the plugin methods it calls?
    private bool Leads(ISymbol? symbol) => Leads(symbol, new HashSet<ISymbol>(SymbolEqualityComparer.Default), out _);

    // A "no" that depended on a method still being decided (a call cycle) isn't remembered.
    private bool Leads(ISymbol? symbol, HashSet<ISymbol> deciding, out bool provisional)
    {
        provisional = false;
        if (symbol is not IMethodSymbol method) return false;
        if (IsHttpSend(method)) return true;
        method = method.OriginalDefinition;
        if (_leads.TryGetValue(method, out var known)) return known;
        if (!deciding.Add(method)) { provisional = true; return false; }
        var leads = false;
        foreach (var member in Implementations(method))
            foreach (var declaration in member.DeclaringSyntaxReferences.Select(r => r.GetSyntax()))
            {
                var model = Model(declaration.SyntaxTree);
                foreach (var call in declaration.DescendantNodes().OfType<InvocationExpressionSyntax>())
                {
                    leads |= Leads(Symbol(model, call), deciding, out var pending);
                    provisional |= pending;
                }
            }

        deciding.Remove(method);
        if (leads || !provisional) _leads[method] = leads;
        if (leads) provisional = false;
        return leads;
    }

    private static bool IsHttpSend(ISymbol symbol)
    {
        if (symbol is not IMethodSymbol method) return false;
        var origin = method.ReducedFrom ?? method;
        if (origin.ContainingNamespace?.ToDisplayString() == "System.Net.Http.Json" && origin.IsExtensionMethod) return true;
        for (var type = method.ContainingType; type != null; type = type.BaseType)
            if (type.ToDisplayString() is "System.Net.Http.HttpMessageInvoker" or "System.Net.Http.HttpClient")
                return method.Name is not ("Dispose" or "CancelPendingRequests");
        return false;
    }

    // The plugin's own code behind a symbol: itself, or every implementation and override of an interface, abstract or
    // virtual member. Framework members and delegate calls have none.
    private IEnumerable<ISymbol> Implementations(ISymbol symbol)
    {
        symbol = symbol.OriginalDefinition;
        if (symbol is IMethodSymbol { MethodKind: MethodKind.DelegateInvoke }) yield break;
        if (symbol.DeclaringSyntaxReferences.Length > 0 && !symbol.IsAbstract) yield return symbol;
        if (!(symbol.IsAbstract || symbol.IsVirtual || symbol.IsOverride || symbol.ContainingType?.TypeKind == TypeKind.Interface)) yield break;
        foreach (var type in Types())
        {
            // Interface implementations may be explicit (their symbol name includes the interface).
            if (symbol.ContainingType?.TypeKind == TypeKind.Interface)
            {
                if (type.FindImplementationForInterfaceMember(symbol) is { } implementation
                    && !SymbolEqualityComparer.Default.Equals(implementation, symbol) && implementation.DeclaringSyntaxReferences.Length > 0)
                    yield return implementation;
            }
            else
            {
                foreach (var member in type.GetMembers(symbol.Name))
                    if (!SymbolEqualityComparer.Default.Equals(member, symbol) && member.DeclaringSyntaxReferences.Length > 0 && Overrides(member, symbol))
                        yield return member;
            }
        }
    }

    private static bool Overrides(ISymbol member, ISymbol symbol)
    {
        for (var over = Overridden(member); over != null; over = Overridden(over))
            if (SymbolEqualityComparer.Default.Equals(over.OriginalDefinition, symbol)) return true;
        return false;

        static ISymbol? Overridden(ISymbol s) => s switch { IMethodSymbol m => m.OverriddenMethod, IPropertySymbol p => p.OverriddenProperty, _ => null };
    }

    private List<INamedTypeSymbol> Types()
    {
        if (_types != null) return _types;
        var all = new List<INamedTypeSymbol>();
        var pending = new Stack<INamespaceOrTypeSymbol>(new[] { _compilation.Assembly.GlobalNamespace });
        while (pending.Count > 0)
            foreach (var member in pending.Pop().GetMembers())
                if (member is INamespaceSymbol space) pending.Push(space);
                else if (member is INamedTypeSymbol type) { all.Add(type); pending.Push(type); }
        return _types = all;
    }

    private static ISymbol? Symbol(SemanticModel model, InvocationExpressionSyntax call)
    {
        var info = model.GetSymbolInfo(call);
        return info.Symbol ?? (info.CandidateSymbols.Length == 1 ? info.CandidateSymbols[0] : null);
    }

    // Not on the way to the write: code that leaves before it (a return or throw that doesn't hold it, or a block that
    // always ends in one with no break, continue or goto inside; with no write in view, every return leads back to it), a
    // local function's declaration (its body runs when it is called, and a call to it is walked) and an async lambda's
    // body (like an async method, it only starts unless it is awaited). Any other lambda's body is walked, as it may run
    // on the way.
    private static bool Skip(SyntaxNode node, SyntaxNode? target)
        => (target != null && !node.Span.Contains(target.Span) && (node is ReturnStatementSyntax or ThrowStatementSyntax or ThrowExpressionSyntax
                || node is BlockSyntax { Statements: [.., ReturnStatementSyntax or ThrowStatementSyntax] } block && !block.DescendantNodes().Any(d => d is BreakStatementSyntax or ContinueStatementSyntax or GotoStatementSyntax)))
            || node is LocalFunctionStatementSyntax || node is AnonymousFunctionExpressionSyntax { AsyncKeyword.RawKind: (int)SyntaxKind.AsyncKeyword };

    private static bool IsLoop(SyntaxNode node) => node is ForStatementSyntax or CommonForEachStatementSyntax or WhileStatementSyntax or DoStatementSyntax;

    // The function a node runs in: a method, accessor, constructor, local function or lambda.
    private static SyntaxNode? Function(SyntaxNode node)
    {
        var owner = node.Ancestors().FirstOrDefault(a => a is BaseMethodDeclarationSyntax or AccessorDeclarationSyntax or LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax or PropertyDeclarationSyntax);
        return owner == null ? null : BodyOf(owner);
    }

    private static SyntaxNode? BodyOf(SyntaxNode owner) => owner switch
    {
        BaseMethodDeclarationSyntax m => (SyntaxNode?)m.Body ?? m.ExpressionBody,
        AccessorDeclarationSyntax a => (SyntaxNode?)a.Body ?? a.ExpressionBody,
        LocalFunctionStatementSyntax l => (SyntaxNode?)l.Body ?? l.ExpressionBody,
        AnonymousFunctionExpressionSyntax f => f.Body,
        PropertyDeclarationSyntax p => p.ExpressionBody,
        _ => null,
    };

    private static string Where(SyntaxNode node)
    {
        var span = node.GetLocation().GetLineSpan();
        return Path.GetFileName(span.Path) + ":" + (span.StartLinePosition.Line + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    private static string Line(SyntaxNode node) => node.SyntaxTree.GetText().Lines[node.GetLocation().GetLineSpan().StartLinePosition.Line].ToString().Trim();
}
