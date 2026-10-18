using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
using Microsoft.CodeAnalysis.Text;

namespace JE.Tests;

/// <summary>
/// 4c1 review round 3 (4c1-r3-security-4): the list gate's source rules, checked by Roslyn over the plugin's whole source
/// (every production type, by symbols rather than text). Line and regex matching let through a grant made with a
/// target-typed <c>new(...)</c>, a grant passed through an ungated delegate named <c>write()</c> and a view made with
/// <c>new()</c>. The rules:
/// <list type="bullet">
/// <item>A <c>ListWrite</c> or <c>ListGrant</c> is constructed only inside <c>ListGate</c>, a <c>ListViewDto</c> only inside
/// <c>ListService.BuildView</c> (any spelling of <c>new</c>; no reflection over them).</item>
/// <item>Every call of an <c>IListHost</c> write takes, as its grant, a gate call made right there: the gate itself, a
/// plugin helper that only returns one, or a delegate whose every origin is one (a parameter: the argument at every call
/// site; a local: its one assignment). No await anywhere in the write's arguments; never a method group.</item>
/// <item>Every <c>ListService.BuildView</c> runs inside a lambda handed to <c>ListGate.ProjectAsync</c>, on that lambda's
/// own grant.</item>
/// <item>Every ask and person save (and every grant <c>CheckedAsync</c> answers) comes after a gate check that always runs
/// before it in the same function, with no await or blocking wait in between.</item>
/// <item>Every <c>IListHost</c> implementation spends its grant first.</item>
/// </list>
/// </summary>
internal sealed class ListGateWalk
{
    private const string Lists = "Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.";
    private static readonly Lazy<ListGateWalk> _plugin = new(() => new ListGateWalk(Load()));

    // The gate's checks (VisibilityAsync and the stamps only read; they allow nothing).
    private static readonly HashSet<string> GateChecks = new(StringComparer.Ordinal)
    {
        "Current", "Edit", "Write", "SwapWrite", "CreateWrite", "FinishWrite", "Person", "SwapAllowed", "ProjectAsync", "GrantAsync",
    };

    private readonly CSharpCompilation _compilation;
    private readonly Dictionary<SyntaxTree, SemanticModel> _models = new();

    private ListGateWalk(CSharpCompilation compilation) => _compilation = compilation;

    /// <summary>The plugin as it is on disk.</summary>
    internal static ListGateWalk Plugin => _plugin.Value;

    private INamedTypeSymbol Type(string name) => _compilation.GetTypeByMetadataName(name) ?? throw new Xunit.Sdk.XunitException(name + " does not exist");

    private INamedTypeSymbol ListWrite => Type(Lists + "ListWrite");

    private INamedTypeSymbol ListGrant => Type(Lists + "ListGrant");

    private INamedTypeSymbol Gate => Type(Lists + "ListGate");

    private INamedTypeSymbol Host => Type(Lists + "IListHost");

    private INamedTypeSymbol Service => Type(Lists + "ListService");

    private INamedTypeSymbol View => Type("Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders.ListViewDto");

    private static CSharpCompilation Load()
    {
        var root = Path.Combine(Root(), "Jellyfin.Plugin.JellyfinEnhanced");
        // The test runs on the runtime of the target it was built for: .NET 10 is the Jellyfin 12 build, .NET 9 the 10.11 one.
        var options = new CSharpParseOptions(LanguageVersion.Latest, preprocessorSymbols: new[] { Environment.Version.Major >= 10 ? "JF12" : "JF10" });
        var trees = Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
            .Where(f => !f[root.Length..].Split(Path.DirectorySeparatorChar).Any(d => d is "obj" or "bin"))
            .OrderBy(f => f, StringComparer.Ordinal)
            .Select(f => CSharpSyntaxTree.ParseText(SourceText.From(Unwrap(File.ReadAllText(f))), options, f))
            .Append(CSharpSyntaxTree.ParseText("global using System; global using System.Collections.Generic; global using System.IO; global using System.Linq; global using System.Net.Http; global using System.Threading; global using System.Threading.Tasks;", options, "ImplicitUsings.cs"));
        var paths = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator).Concat(Directory.EnumerateFiles(AppContext.BaseDirectory, "*.dll")))
        {
            var name = Path.GetFileNameWithoutExtension(path);
            if (name is "Jellyfin.Plugin.JellyfinEnhanced" or "JE.Tests" || paths.ContainsKey(name))
            {
                continue;
            }

            try
            {
                AssemblyName.GetAssemblyName(path);
            }
            catch (BadImageFormatException)
            {
                continue;
            }

            paths[name] = path;
        }

        return CSharpCompilation.Create("Jellyfin.Plugin.JellyfinEnhanced", trees, paths.Values.Select(p => MetadataReference.CreateFromFile(p)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable, allowUnsafe: true));
    }

    // Runtime await boundaries are independently checked and injected by ListsContinuationTests. This walk remains
    // defence in depth for the underlying access gates; transparent synchronous task factories are lowered before
    // analysis so a CheckedAsync call still belongs to the function that awaits its result.
    private static string Unwrap(string source) => new TaskFactories().Visit(CSharpSyntaxTree.ParseText(source).GetRoot())!.ToFullString();

    private sealed class TaskFactories : CSharpSyntaxRewriter
    {
        public override SyntaxNode? VisitInvocationExpression(InvocationExpressionSyntax node)
        {
            var rewritten = (InvocationExpressionSyntax)base.VisitInvocationExpression(node)!;
            return rewritten.Expression.ToString() == "ListContinuation.Await"
                && rewritten.ArgumentList.Arguments.FirstOrDefault()?.Expression is ParenthesizedLambdaExpressionSyntax { Body: ExpressionSyntax body }
                ? body.WithTriviaFrom(rewritten) : rewritten;
        }
    }

    /// <summary>The same plugin with one file's text changed (a planted bypass).</summary>
    internal ListGateWalk With(string relative, Func<string, string> change)
    {
        var tree = Tree(relative);
        var changed = CSharpSyntaxTree.ParseText(SourceText.From(change(tree.GetText().ToString())), (CSharpParseOptions)tree.Options, tree.FilePath);
        return new ListGateWalk(_compilation.ReplaceSyntaxTree(tree, changed));
    }

    /// <summary>Compile errors in one file or the whole plugin (symbols are only followed reliably in code that compiles).</summary>
    internal List<string> Errors(string? relative = null)
        => (relative == null ? _compilation.GetDiagnostics() : Model(Tree(relative)).GetDiagnostics())
            .Where(d => d.Severity == DiagnosticSeverity.Error && d.Id != "CS0619").Select(d => d.ToString()).ToList();

    /// <summary>Every rule over the whole plugin: what breaks one, one line each.</summary>
    internal List<string> Problems()
    {
        var problems = new List<string>();
        Creations(problems);
        HostWrites(problems);
        Views(problems);
        Effects(problems);
        Spends(problems);
        return problems;
    }

    // ── Constructions ──────────────────────────────────────────────────────

    private void Creations(List<string> problems)
    {
        var watched = new[] { "ListWrite", "ListGrant", "ListViewDto", "CreateInstance", "GetUninitializedObject" };
        foreach (var (tree, model) in Plugin_())
        {
            // Binding is what costs: a node that can't name a gate type isn't bound. A file with a using alias may name
            // one under another name, so everything there is.
            var root = tree.GetRoot();
            var aliased = root.DescendantNodes().OfType<UsingDirectiveSyntax>().Any(u => u.Alias != null);
            bool Named(SyntaxNode node) => aliased || node is ImplicitObjectCreationExpressionSyntax
                || node.DescendantTokens().Any(t => t.IsKind(SyntaxKind.IdentifierToken) && watched.Contains(t.ValueText));
            foreach (var node in root.DescendantNodes().Where(n => n is BaseObjectCreationExpressionSyntax or TypeOfExpressionSyntax or InvocationExpressionSyntax && (n is not InvocationExpressionSyntax || n.ToString().Contains("Create", StringComparison.Ordinal) || n.ToString().Contains("GetUninitializedObject", StringComparison.Ordinal))).Where(Named))
            {
                switch (node)
                {
                    case BaseObjectCreationExpressionSyntax creation when model.GetTypeInfo(creation).Type is INamedTypeSymbol made:
                        if (Is(made, ListWrite) || Is(made, ListGrant))
                        {
                            if (!Is(Member(model, creation)?.ContainingType, Gate))
                            {
                                problems.Add($"a {made.Name} made outside the gate at {Where(node)}: {Line(node)}");
                            }
                        }
                        else if (Derives(made, View) && !IsBuildView(Member(model, creation)))
                        {
                            problems.Add($"a ListViewDto made outside ListService.BuildView at {Where(node)}: {Line(node)}");
                        }

                        break;
                    case TypeOfExpressionSyntax type when model.GetTypeInfo(type.Type).Type is INamedTypeSymbol named && (Is(named, ListWrite) || Is(named, ListGrant) || Derives(named, View)):
                        problems.Add($"{named.Name} used by reflection at {Where(node)}: {Line(node)}");
                        break;
                    case InvocationExpressionSyntax call when model.GetSymbolInfo(call).Symbol is IMethodSymbol { IsGenericMethod: true } generic
                        && generic.ContainingType.ToDisplayString() is "System.Activator" or "System.Runtime.CompilerServices.RuntimeHelpers"
                        && generic.TypeArguments.OfType<INamedTypeSymbol>().Any(t => Is(t, ListWrite) || Is(t, ListGrant) || Derives(t, View)):
                        problems.Add($"a gate type made by reflection at {Where(node)}: {Line(node)}");
                        break;
                }
            }
        }
    }

    // ── Jellyfin writes ────────────────────────────────────────────────────

    private void HostWrites(List<string> problems)
    {
        var writes = Host.GetMembers().OfType<IMethodSymbol>().Where(m => m.Parameters.FirstOrDefault() is { } p && Is(p.Type, ListWrite)).ToList();
        if (writes.Count == 0)
        {
            problems.Add("IListHost has no write taking a ListWrite");
        }

        var seen = 0;
        foreach (var (tree, model) in Plugin_())
        {
            var names = writes.Select(w => w.Name).ToHashSet(StringComparer.Ordinal);
            foreach (var name in tree.GetRoot().DescendantNodes().OfType<SimpleNameSyntax>().Where(n => names.Contains(n.Identifier.Text)))
            {
                if (model.GetSymbolInfo(name).Symbol is not IMethodSymbol method || !writes.Any(w => Implements(method, w)))
                {
                    continue;
                }

                if (Invoked(name) is not { } call)
                {
                    problems.Add($"an IListHost write used as a method group at {Where(name)}: {Line(name)}");
                    continue;
                }

                seen++;
                if (model.GetOperation(call) is not IInvocationOperation operation)
                {
                    problems.Add($"a write the walk can't resolve at {Where(call)}");
                    continue;
                }

                var grant = operation.Arguments.FirstOrDefault(a => a.Parameter != null && Is(a.Parameter.Type, ListWrite));
                if (grant == null || grant.Value.Syntax is not ExpressionSyntax value)
                {
                    problems.Add($"a write without its grant at {Where(call)}: {Line(call)}");
                    continue;
                }

                if (call.ArgumentList.DescendantNodes().Any(Waits))
                {
                    problems.Add($"a write that awaits in its arguments at {Where(call)}: {Line(call)}");
                }

                if (Ungated(model, value, 0) is { } why)
                {
                    problems.Add($"a write whose grant isn't made by the gate right there ({why}) at {Where(call)}: {Line(call)}");
                }
            }
        }

        if (seen < 6)
        {
            problems.Add($"only {seen} Jellyfin writes found");
        }
    }

    // Null when the expression is a grant the gate makes as it is evaluated; else why not.
    private string? Ungated(SemanticModel model, ExpressionSyntax expression, int depth)
    {
        if (depth > 6)
        {
            return "too deep to follow";
        }

        switch (expression)
        {
            case ParenthesizedExpressionSyntax parenthesized:
                return Ungated(model, parenthesized.Expression, depth);
            case PostfixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression } bang:
                return Ungated(model, bang.Operand, depth);
            case BinaryExpressionSyntax { RawKind: (int)SyntaxKind.CoalesceExpression } coalesce when coalesce.Right is ThrowExpressionSyntax:
                return Ungated(model, coalesce.Left, depth);
            case ConditionalAccessExpressionSyntax access when access.WhenNotNull is InvocationExpressionSyntax bound:
                return GateCall(model, bound, depth);
            case InvocationExpressionSyntax call:
                return GateCall(model, call, depth);
            default:
                return "not a call: " + expression;
        }
    }

    private string? GateCall(SemanticModel model, InvocationExpressionSyntax call, int depth)
    {
        if (call.ArgumentList.DescendantNodes().Any(Waits))
        {
            return "awaits in its arguments";
        }

        var symbol = model.GetSymbolInfo(call).Symbol as IMethodSymbol;
        if (symbol == null)
        {
            return "an unresolved call";
        }

        if (Is(symbol.ContainingType, Gate))
        {
            return Is(symbol.ReturnType, ListWrite) ? null : "a gate call that makes no grant";
        }

        if (symbol.MethodKind == MethodKind.DelegateInvoke)
        {
            var target = call.Expression is MemberAccessExpressionSyntax { Name.Identifier.Text: "Invoke" } invoke ? invoke.Expression : call.Expression;
            return DelegateOrigins(model, target, depth);
        }

        return Helper(symbol, depth);
    }

    // A plugin method that only returns a grant the gate makes (ListSwapService.SwapWrite).
    private string? Helper(IMethodSymbol method, int depth)
    {
        method = method.OriginalDefinition;
        if (method.IsAsync || !Is(method.ReturnType, ListWrite) || method.IsAbstract || method.IsVirtual || method.DeclaringSyntaxReferences.Length != 1)
        {
            return $"{method.ContainingType.Name}.{method.Name} isn't a gate helper";
        }

        var declaration = method.DeclaringSyntaxReferences[0].GetSyntax() as MethodDeclarationSyntax;
        var returned = declaration?.ExpressionBody?.Expression
            ?? (declaration?.Body?.Statements is [ReturnStatementSyntax { Expression: { } only }] ? only : null);
        return returned == null ? $"{method.Name} does more than return a grant" : Ungated(Model(declaration!.SyntaxTree), returned, depth + 1);
    }

    // A delegate's every origin: a parameter's argument at every call site, or a local's one assignment.
    private string? DelegateOrigins(SemanticModel model, ExpressionSyntax target, int depth)
    {
        switch (model.GetSymbolInfo(target).Symbol)
        {
            case IParameterSymbol parameter when parameter.ContainingSymbol is IMethodSymbol { MethodKind: MethodKind.Ordinary } owner:
            {
                var sites = 0;
                foreach (var (tree, inner) in Plugin_())
                {
                    foreach (var name in tree.GetRoot().DescendantNodes().OfType<SimpleNameSyntax>().Where(n => n.Identifier.Text == owner.Name))
                    {
                        if (!SymbolEqualityComparer.Default.Equals(inner.GetSymbolInfo(name).Symbol?.OriginalDefinition, owner.OriginalDefinition))
                        {
                            continue;
                        }

                        if (Invoked(name) is not { } call || inner.GetOperation(call) is not IInvocationOperation operation)
                        {
                            return $"{owner.Name} is used as a method group at {Where(name)}";
                        }

                        sites++;
                        var argument = operation.Arguments.FirstOrDefault(a => SymbolEqualityComparer.Default.Equals(a.Parameter?.OriginalDefinition, parameter.OriginalDefinition));
                        if (argument?.Value.Syntax is not ExpressionSyntax given || Origin(inner, given, depth + 1) is { } why)
                        {
                            return $"{parameter.Name} of {owner.Name} is given an ungated grant at {Where(call)}";
                        }
                    }
                }

                return null;
            }

            case ILocalSymbol local:
            {
                var declarator = local.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).OfType<VariableDeclaratorSyntax>().FirstOrDefault();
                if (declarator?.Initializer?.Value is not { } initial || Origin(model, initial, depth) is not null)
                {
                    return $"the delegate {local.Name} isn't a gate call";
                }

                var body = declarator.Ancestors().FirstOrDefault(a => a is BaseMethodDeclarationSyntax or AccessorDeclarationSyntax or LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax);
                var reassigned = body?.DescendantNodes().OfType<AssignmentExpressionSyntax>()
                    .Any(a => SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(a.Left).Symbol, local)) ?? true;
                return reassigned ? $"the delegate {local.Name} is assigned again" : null;
            }

            case { } other:
                return $"a delegate the walk can't follow ({other.Name})";
            default:
                return "an unresolved delegate";
        }
    }

    // A delegate's value: a lambda (not async) that only returns a gate call, or a method group of a gate method or helper.
    private string? Origin(SemanticModel model, ExpressionSyntax given, int depth)
    {
        switch (given)
        {
            case ParenthesizedExpressionSyntax parenthesized:
                return Origin(model, parenthesized.Expression, depth);
            case AnonymousFunctionExpressionSyntax lambda when lambda.AsyncKeyword.IsKind(SyntaxKind.None):
                var returned = lambda.ExpressionBody ?? (lambda.Block?.Statements is [ReturnStatementSyntax { Expression: { } only }] ? only : null);
                return returned == null ? "a lambda that does more than return a grant" : Ungated(model, returned, depth + 1);
            case AnonymousFunctionExpressionSyntax:
                return "an async lambda";
            default:
                switch (model.GetSymbolInfo(given).Symbol)
                {
                    case IMethodSymbol group:
                        return Is(group.ContainingType, Gate) && Is(group.ReturnType, ListWrite) ? null : Helper(group, depth + 1);
                    case IParameterSymbol or ILocalSymbol:
                        // A delegate handed on: its own origins.
                        return depth > 6 ? "too deep to follow" : DelegateOrigins(model, given, depth + 1);
                    default:
                        return "not a lambda, method group or gated delegate";
                }
        }
    }

    // ── Views ──────────────────────────────────────────────────────────────

    private void Views(List<string> problems)
    {
        var builds = 0;
        foreach (var (tree, model) in Plugin_())
        {
            foreach (var name in tree.GetRoot().DescendantNodes().OfType<SimpleNameSyntax>().Where(n => n.Identifier.Text == "BuildView"))
            {
                if (!IsBuildView(model.GetSymbolInfo(name).Symbol))
                {
                    continue;
                }

                if (Invoked(name) is not { } call)
                {
                    if (name.Parent is not MethodDeclarationSyntax)
                    {
                        problems.Add($"BuildView used as a method group at {Where(name)}");
                    }

                    continue;
                }

                builds++;
                var lambda = call.Ancestors().OfType<AnonymousFunctionExpressionSyntax>().FirstOrDefault();
                var projection = lambda?.Parent is ArgumentSyntax { Parent: ArgumentListSyntax { Parent: InvocationExpressionSyntax outer } } ? outer : null;
                var projected = projection != null && model.GetSymbolInfo(projection).Symbol is IMethodSymbol p && Is(p.ContainingType, Gate) && p.Name == "ProjectAsync";
                var parameter = lambda switch
                {
                    SimpleLambdaExpressionSyntax simple => model.GetDeclaredSymbol(simple.Parameter),
                    ParenthesizedLambdaExpressionSyntax full when full.ParameterList.Parameters.Count == 1 => model.GetDeclaredSymbol(full.ParameterList.Parameters[0]),
                    _ => null,
                };
                var first = call.ArgumentList.Arguments.FirstOrDefault()?.Expression;
                var own = first != null && parameter != null && SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(first).Symbol, parameter);
                if (!projected || !own || lambda!.AsyncKeyword.IsKind(SyntaxKind.AsyncKeyword) || lambda.DescendantNodes().Any(Waits))
                {
                    problems.Add($"a view built outside the gate's projection (or not on its grant) at {Where(call)}: {Line(call)}");
                }
            }
        }

        if (builds < 5)
        {
            problems.Add($"only {builds} view builds found");
        }
    }

    // ── Asks and person saves ──────────────────────────────────────────────

    private void Effects(List<string> problems)
    {
        var store = Type(Lists + "ListStore");
        var requests = Type("Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestService");
        var checkedWrite = Service.GetTypeMembers("CheckedWrite").Single();
        var counted = 0;
        foreach (var (tree, model) in Plugin_())
        {
            foreach (var node in tree.GetRoot().DescendantNodes())
            {
                ISymbol? effect = node switch
                {
                    SimpleNameSyntax name when name.Identifier.Text is "Save" or "SaveIfChanged" or "CreateAsync" => model.GetSymbolInfo(name).Symbol,
                    BaseObjectCreationExpressionSyntax creation when creation is ImplicitObjectCreationExpressionSyntax || creation.ToString().Contains("CheckedWrite", StringComparison.Ordinal) => model.GetSymbolInfo(creation).Symbol,
                    _ => null,
                };
                var where = Member(model, node);
                var owner = where?.ContainingType;
                string? kind = effect switch
                {
                    IMethodSymbol m when Is(m.ContainingType, store) && m.Name == "Save" && (Is(owner, Service) || owner?.Name == "ListAcquisition") => "a person save",
                    IMethodSymbol m when Is(m.ContainingType, Service) && m.Name == "SaveIfChanged" => "a person save",
                    IMethodSymbol m when Is(m.ContainingType, requests) && m.Name == "CreateAsync" && owner?.Name == "ListAcquisition" => "an ask",
                    IMethodSymbol { MethodKind: MethodKind.Constructor } m when Is(m.ContainingType, checkedWrite) && node is BaseObjectCreationExpressionSyntax c
                        && c.ArgumentList?.Arguments.FirstOrDefault()?.Expression is LiteralExpressionSyntax { RawKind: (int)SyntaxKind.NullLiteralExpression } => "a checked grant",
                    _ => null,
                };
                if (kind == null || (Is(owner, Service) && where!.Name is "Reconciled" or "SaveIfChanged"))
                {
                    continue;
                }

                if (node is SimpleNameSyntax simple && Invoked(simple) == null)
                {
                    if (simple.Parent is not MethodDeclarationSyntax)
                    {
                        problems.Add($"{kind} used as a method group at {Where(node)}: {Line(node)}");
                    }

                    continue;
                }

                counted++;
                var target = node is SimpleNameSyntax s ? Invoked(s)! : (ExpressionSyntax)node;
                var gates = kind == "a checked grant" ? new HashSet<string> { "Edit" } : GateChecks;
                After(model, target, gates, kind, problems);
            }
        }

        if (counted < 5)
        {
            problems.Add($"only {counted} asks and saves found");
        }
    }

    // The last gate check before the effect in its function: it always runs first, and nothing between them waits.
    private void After(SemanticModel model, ExpressionSyntax effect, HashSet<string> gates, string kind, List<string> problems)
    {
        var body = Function(effect);
        if (body == null)
        {
            problems.Add($"{kind} outside a function at {Where(effect)}");
            return;
        }

        var asked = body.DescendantNodes().OfType<InvocationExpressionSyntax>()
            .Where(i => Function(i) == body && i.Span.End <= effect.SpanStart && IsGateCheck(model, i, gates))
            .OrderBy(i => i.SpanStart).LastOrDefault();
        if (asked == null)
        {
            problems.Add($"{kind} with no gate check before it at {Where(effect)}: {Line(effect)}");
            return;
        }

        var statement = asked.FirstAncestorOrSelf<StatementSyntax>()!;
        var skippable = asked.Ancestors().TakeWhile(a => a != statement).Any(a => a switch
        {
            BinaryExpressionSyntax b when b.Kind() is SyntaxKind.LogicalAndExpression or SyntaxKind.LogicalOrExpression or SyntaxKind.CoalesceExpression => b.Right.Span.Contains(asked.Span),
            ConditionalExpressionSyntax c => !c.Condition.Span.Contains(asked.Span),
            ConditionalAccessExpressionSyntax c => c.WhenNotNull.Span.Contains(asked.Span),
            _ => false,
        });
        var holder = statement.Parent as BlockSyntax;
        if (skippable || (holder == null && statement.Parent is not (SwitchSectionSyntax or GlobalStatementSyntax)) || (holder != null && !holder.Span.Contains(effect.Span)))
        {
            problems.Add($"the gate check at {Where(asked)} doesn't always run before {kind} at {Where(effect)}");
        }

        // From the end of the gate call to the effect: everything that runs on the way (code that returns or throws before
        // the effect is not on it).
        var containers = effect.Ancestors().ToHashSet();
        var between = body.DescendantNodes(n => !Skip(n, effect))
            .Where(n => n.SpanStart >= asked.Span.End && n.SpanStart < effect.SpanStart && !containers.Contains(n) && !Skip(n, effect))
            .Concat(effect is InvocationExpressionSyntax invoked ? invoked.ArgumentList.DescendantNodes() : effect.DescendantNodes());
        foreach (var node in between)
        {
            if (Waits(node) || BlockingWait(model, node))
            {
                problems.Add($"{kind} waits after the gate check at {Where(asked)}: {Where(node)}: {Line(node)}");
                return;
            }
        }
    }

    private bool IsGateCheck(SemanticModel model, InvocationExpressionSyntax call, HashSet<string> gates)
        => model.GetSymbolInfo(call).Symbol is IMethodSymbol m
            && ((Is(m.ContainingType, Gate) && gates.Contains(m.Name)) || (gates == GateChecks && Is(m.ContainingType, Service) && m.Name == "CheckedAsync"));

    // ── Host implementations ───────────────────────────────────────────────

    private void Spends(List<string> problems)
    {
        var writes = Host.GetMembers().OfType<IMethodSymbol>().Where(m => m.Parameters.FirstOrDefault() is { } p && Is(p.Type, ListWrite)).ToList();
        var spend = ListWrite.GetMembers("Spend").Single();
        foreach (var type in Types().Where(t => t.TypeKind == TypeKind.Class && t.AllInterfaces.Any(i => Is(i, Host))))
        {
            foreach (var write in writes)
            {
                if (type.FindImplementationForInterfaceMember(write) is not IMethodSymbol method || method.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() is not MethodDeclarationSyntax declaration)
                {
                    continue;
                }

                var model = Model(declaration.SyntaxTree);
                var first = declaration.Body?.Statements.FirstOrDefault() as ExpressionStatementSyntax;
                var spent = first?.Expression is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax member } call
                    && SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(call).Symbol, spend)
                    && SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(member.Expression).Symbol, method.Parameters[0]);
                if (!spent)
                {
                    problems.Add($"{type.Name}.{method.Name} doesn't spend its grant first");
                }
            }
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    private IEnumerable<(SyntaxTree Tree, SemanticModel Model)> Plugin_()
        => _compilation.SyntaxTrees.Where(t => t.FilePath != "ImplicitUsings.cs").Select(t => (t, Model(t)));

    private SyntaxTree Tree(string relative)
    {
        var suffix = Path.DirectorySeparatorChar + relative.Replace('/', Path.DirectorySeparatorChar);
        return _compilation.SyntaxTrees.Single(t => t.FilePath.EndsWith(suffix, StringComparison.Ordinal));
    }

    private SemanticModel Model(SyntaxTree tree)
    {
        if (!_models.TryGetValue(tree, out var model))
        {
            _models[tree] = model = _compilation.GetSemanticModel(tree);
        }

        return model;
    }

    private List<INamedTypeSymbol> Types()
    {
        var all = new List<INamedTypeSymbol>();
        var pending = new Stack<INamespaceOrTypeSymbol>(new[] { _compilation.Assembly.GlobalNamespace });
        while (pending.Count > 0)
        {
            foreach (var member in pending.Pop().GetMembers())
            {
                if (member is INamespaceSymbol space)
                {
                    pending.Push(space);
                }
                else if (member is INamedTypeSymbol type)
                {
                    all.Add(type);
                    pending.Push(type);
                }
            }
        }

        return all;
    }

    private static bool Is(ITypeSymbol? type, INamedTypeSymbol wanted) => SymbolEqualityComparer.Default.Equals(type?.OriginalDefinition, wanted);

    private static bool Derives(ITypeSymbol? type, INamedTypeSymbol wanted)
    {
        for (var t = type; t != null; t = t.BaseType)
        {
            if (Is(t, wanted))
            {
                return true;
            }
        }

        return false;
    }

    private bool IsBuildView(ISymbol? symbol) => symbol is IMethodSymbol { Name: "BuildView" } m && Is(m.ContainingType, Service);

    private static bool Implements(IMethodSymbol method, IMethodSymbol write)
    {
        method = method.OriginalDefinition;
        return SymbolEqualityComparer.Default.Equals(method, write)
            || method.ExplicitInterfaceImplementations.Any(i => SymbolEqualityComparer.Default.Equals(i, write))
            || SymbolEqualityComparer.Default.Equals(method.ContainingType.FindImplementationForInterfaceMember(write), method);
    }

    // The method, accessor, constructor or property a node is in.
    private static ISymbol? Member(SemanticModel model, SyntaxNode node)
    {
        var declaration = node.Ancestors().FirstOrDefault(a => a is BaseMethodDeclarationSyntax or AccessorDeclarationSyntax or PropertyDeclarationSyntax or FieldDeclarationSyntax);
        return declaration switch
        {
            FieldDeclarationSyntax field => model.GetDeclaredSymbol(field.Declaration.Variables[0]),
            AccessorDeclarationSyntax accessor => model.GetDeclaredSymbol(accessor),
            { } member => model.GetDeclaredSymbol(member),
            _ => null,
        };
    }

    // The call a name is the method of, or null when the name is a method group.
    private static InvocationExpressionSyntax? Invoked(SimpleNameSyntax name)
    {
        SyntaxNode expression = name.Parent is MemberAccessExpressionSyntax member && member.Name == name ? member
            : name.Parent is MemberBindingExpressionSyntax binding ? binding
            : name;
        return expression.Parent is InvocationExpressionSyntax call && call.Expression == expression ? call : null;
    }

    private static bool Waits(SyntaxNode node) => node switch
    {
        AwaitExpressionSyntax => true,
        UsingStatementSyntax u => u.AwaitKeyword.IsKind(SyntaxKind.AwaitKeyword),
        LocalDeclarationStatementSyntax l => l.AwaitKeyword.IsKind(SyntaxKind.AwaitKeyword),
        CommonForEachStatementSyntax f => f.AwaitKeyword.IsKind(SyntaxKind.AwaitKeyword),
        _ => false,
    };

    private static bool BlockingWait(SemanticModel model, SyntaxNode node)
    {
        var symbol = node switch
        {
            InvocationExpressionSyntax i => model.GetSymbolInfo(i).Symbol,
            MemberAccessExpressionSyntax { Name.Identifier.Text: "Result" } m => model.GetSymbolInfo(m).Symbol,
            _ => null,
        };
        var space = symbol?.ContainingNamespace?.ToDisplayString();
        return space is "System.Threading" or "System.Threading.Tasks" or "System.Runtime.CompilerServices"
            && symbol!.Name is "Wait" or "WaitAll" or "WaitAny" or "WaitOne" or "Sleep" or "SpinUntil" or "Join" or "GetResult" or "Result";
    }

    // Not on the way to the effect: a return or throw (or a block ending in one) that doesn't hold it, a local function's
    // declaration and an async lambda's body (they run when called or awaited, which is then on the way).
    private static bool Skip(SyntaxNode node, SyntaxNode target)
        => (!node.Span.Contains(target.Span) && (node is ReturnStatementSyntax or ThrowStatementSyntax or ThrowExpressionSyntax
                || (node is BlockSyntax { Statements: [.., ReturnStatementSyntax or ThrowStatementSyntax] } block && !block.DescendantNodes().Any(d => d is BreakStatementSyntax or ContinueStatementSyntax or GotoStatementSyntax))))
            || node is LocalFunctionStatementSyntax || node is AnonymousFunctionExpressionSyntax { AsyncKeyword.RawKind: (int)SyntaxKind.AsyncKeyword };

    // The function a node runs in: a method, accessor, constructor, local function or lambda.
    private static SyntaxNode? Function(SyntaxNode node)
    {
        var owner = node.Ancestors().FirstOrDefault(a => a is BaseMethodDeclarationSyntax or AccessorDeclarationSyntax or LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax or PropertyDeclarationSyntax);
        return owner switch
        {
            BaseMethodDeclarationSyntax m => (SyntaxNode?)m.Body ?? m.ExpressionBody,
            AccessorDeclarationSyntax a => (SyntaxNode?)a.Body ?? a.ExpressionBody,
            LocalFunctionStatementSyntax l => (SyntaxNode?)l.Body ?? l.ExpressionBody,
            AnonymousFunctionExpressionSyntax f => f.Body,
            PropertyDeclarationSyntax p => p.ExpressionBody,
            _ => null,
        };
    }

    private static string Where(SyntaxNode node)
    {
        var span = node.GetLocation().GetLineSpan();
        return Path.GetFileName(span.Path) + ":" + (span.StartLinePosition.Line + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    private static string Line(SyntaxNode node) => node.SyntaxTree.GetText().Lines[node.GetLocation().GetLineSpan().StartLinePosition.Line].ToString().Trim();

    // The repository: found from this file's own path (the tests may run from a build folder anywhere).
    internal static string Root([System.Runtime.CompilerServices.CallerFilePath] string here = "")
    {
        var root = new DirectoryInfo(Path.GetDirectoryName(here) ?? AppContext.BaseDirectory);
        while (root != null && !Directory.Exists(Path.Combine(root.FullName, "Jellyfin.Plugin.JellyfinEnhanced", "Services")))
        {
            root = root.Parent;
        }

        Assert.NotNull(root);
        return root!.FullName;
    }
}
