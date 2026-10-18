using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace JE.Tests;

/// <summary>
/// 4b review round 4 (security-r4-2): the walk behind the destination source test. It compiles the plugin's own source and
/// reads the ledger and charges files by syntax and symbols, not by line or text. A value that says where a request goes
/// or what it asks for (a protected member: its seasons, episodes, arr or Seerr routing, its target) may only be compared
/// or selected on inside the one rule (<c>RequestDestination</c>, and <c>MutationInput.Extra</c>, which asks it). Anywhere
/// else a comparison of such a value with a value from somewhere else is reported: an operator, a comparing call
/// (Contains, IndexOf, Intersect, SequenceEqual, Equals…, a method group of one included), grouping or merging requests by
/// it (GroupBy, SelectMany…), a lookup keyed by it, and a call into a plugin helper outside these files that does any of
/// that with what it is given (followed through further helpers). Values are followed through locals, lambda parameters,
/// loops and patterns. Two values from the same source (one request's own fields) are not "another request"; two requests
/// taken from one collection (by index, or as its first, last… element) are two sources (review round 5, security-r5-2).
/// <para>Defence in depth (D41's principle, review round 5): a static walk over arbitrary C# can't be complete, and this one
/// doesn't try to be. The guarantee is <c>RequestDestination.Serves</c> on every path, proven by the runtime tables
/// (IntegrationSeerrDestinationTableTests, IntegrationRequestWithdrawalTableTests, IntegrationRequestDestinationSightTableTests,
/// IntegrationTitleIdentityTableTests). The walk catches the cheap, likely ways of going around it; a new bypass it misses is
/// fixed here when it is cheap, and otherwise covered by a runtime row.</para>
/// </summary>
internal sealed class DestinationRuleWalk
{
    /// <summary>The files where one request may stand for another: every part of the ledger, and the charges.</summary>
    internal static readonly string[] RuleFiles = { "RequestLedger.cs", "RequestLedgerImport.cs", "RequestLedgerArrivals.cs", "RequestLedgerTitles.cs", "FutureSeasonCharges.cs" };

    /// <summary>What says where a request goes or what it asks for: type name → members.</summary>
    internal static readonly Dictionary<string, string[]> Protected = new(StringComparer.Ordinal)
    {
        // The title and edition (Q-4BFIX3-2: one identity, compared through RequestDestination.SameTitle/SameEdition/Edition).
        ["MutationInput"] = new[] { "Key", "Variant", "Seasons", "Episodes", "SeasonNumbers", "InstanceId", "ProfileId", "RootFolder", "SeerrServerId", "SeerrProfileId", "SeerrRootFolder", "SeerrOptions" },
        ["RequestEpisode"] = new[] { "Season", "Episode" },
        ["RequestWant"] = new[] { "TargetKey" },
        ["RequestAuthorization"] = new[] { "InstanceId", "ConnectionGeneration", "SeerrSource" },
        ["RequestPolicyFacts"] = new[] { "InstanceId", "ConnectionGeneration", "SeerrSource" },
        ["RequestLedger"] = new[] { "TargetKey", "SeerrTargetKey" },
    };

    // What a protected value says that isn't where or what: whether a title is a movie or a series.
    private static readonly Dictionary<string, string[]> Unprotected = new(StringComparer.Ordinal)
    {
        ["TitleKey"] = new[] { "IsMovie", "Kind" },
    };

    // The request types: a call into a plugin helper that is given one of these is followed.
    private static readonly HashSet<string> RequestTypes = new(StringComparer.Ordinal) { "MutationInput", "RequestWant", "RequestJob", "RequestAuthorization", "RequestEpisode" };

    // Calls that compare what they are given (their receiver and arguments).
    private static readonly HashSet<string> Comparing = new(StringComparer.Ordinal)
    {
        "Equals", "Contains", "ContainsKey", "ContainsValue", "IndexOf", "LastIndexOf", "FindIndex", "Intersect", "IntersectBy", "Except", "ExceptBy", "SequenceEqual",
        "StartsWith", "EndsWith", "Compare", "CompareTo", "CompareOrdinal", "BinarySearch", "Overlaps", "IsSubsetOf", "IsSupersetOf", "IsProperSubsetOf",
        "IsProperSupersetOf", "SetEquals", "Union", "UnionBy", "Exists", "TryGetValue", "Remove",
    };

    // Calls that group or match the elements of a collection by what a selector gives.
    private static readonly HashSet<string> Keyed = new(StringComparer.Ordinal) { "GroupBy", "ToLookup", "ToDictionary", "DistinctBy", "CountBy", "AggregateBy", "Join", "GroupJoin", "UnionBy", "IntersectBy", "ExceptBy" };

    private static readonly Lazy<DestinationRuleWalk> _plugin = new(() => new DestinationRuleWalk(Load()));

    /// <summary>The plugin as it is on disk.</summary>
    internal static DestinationRuleWalk Plugin => _plugin.Value;

    private readonly CSharpCompilation _compilation;
    private readonly Dictionary<SyntaxTree, SemanticModel> _models = new();
    private readonly Dictionary<(IMethodSymbol, int), string?> _helpers = new();

    private DestinationRuleWalk(CSharpCompilation compilation, DestinationRuleWalk? from = null)
    {
        _compilation = compilation;
        // A planted change keeps the plugin's parameter seeds (which parameters receive a protected value): taking a rule
        // call out or adding a raw comparison doesn't change them, and working them out again for every mutant is slow.
        _inherited = from?.InheritedSeeds();
    }

    private readonly (Dictionary<string, HashSet<int>> Seeds, Dictionary<(string, int), HashSet<int>> Delegates)? _inherited;

    private (Dictionary<string, HashSet<int>>, Dictionary<(string, int), HashSet<int>>) InheritedSeeds()
    {
        if (_inherited is { } inherited) return inherited;
        var seeds = Seeds().ToDictionary(kv => Key(kv.Key), kv => kv.Value, StringComparer.Ordinal);
        return (seeds, _delegateSeeds.ToDictionary(kv => (Key(kv.Key.Method), kv.Key.Parameter), kv => kv.Value));
    }

    private static string Key(IMethodSymbol method) => method.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) + "(" + string.Join(",", method.Parameters.Select(p => p.Type.ToDisplayString())) + ")";

    /// <summary>The repository root (the folder holding the plugin's project).</summary>
    internal static string Root()
    {
        static string SourceFile([System.Runtime.CompilerServices.CallerFilePath] string file = "") => file;
        foreach (var start in new[] { Path.GetDirectoryName(SourceFile())!, AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
        {
            var root = new DirectoryInfo(start);
            while (root != null && !Directory.Exists(Path.Combine(root.FullName, "Jellyfin.Plugin.JellyfinEnhanced", "Services"))) root = root.Parent;
            if (root != null) return root.FullName;
        }
        throw new InvalidOperationException("The plugin's source isn't an ancestor of the test run (run from the repository).");
    }

    private static CSharpCompilation Load()
    {
        var root = Path.Combine(Root(), "Jellyfin.Plugin.JellyfinEnhanced");
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
    internal DestinationRuleWalk With(string relative, Func<string, string> change)
    {
        var tree = Tree(relative);
        var text = tree.GetText().ToString();
        var changed = change(text);
        if (changed == text) throw new InvalidOperationException("The change didn't apply to " + relative + ".");
        return new DestinationRuleWalk(_compilation.ReplaceSyntaxTree(tree, CSharpSyntaxTree.ParseText(SourceText.From(changed), (CSharpParseOptions)tree.Options, tree.FilePath)), this);
    }

    /// <summary>A file's text.</summary>
    internal string Text(string relative) => Tree(relative).GetText().ToString();

    /// <summary>
    /// Compile errors in one file or the whole plugin: symbols are only followed reliably in code that compiles. Not CS0619
    /// (an obsolete-as-error member, still resolved: the tests' folder holds SkiaSharp's runtime assembly).
    /// </summary>
    internal List<string> Errors(string? relative = null, int? at = null)
        => (relative == null ? _compilation.GetDiagnostics() : Model(Tree(relative)).GetDiagnostics(at is int position ? Tree(relative).GetRoot().FindToken(position).Parent!.AncestorsAndSelf().OfType<MemberDeclarationSyntax>().First().Span : null))
            .Where(d => d.Severity == DiagnosticSeverity.Error && d.Id != "CS0619").Select(d => d.ToString()).ToList();

    private SyntaxTree Tree(string relative)
    {
        var suffix = Path.DirectorySeparatorChar + relative.Replace('/', Path.DirectorySeparatorChar);
        return _compilation.SyntaxTrees.Single(t => t.FilePath.EndsWith(suffix, StringComparison.Ordinal));
    }

    private static string Requests(string file) => "Services/Acquire/Requests/" + file;

    private SemanticModel Model(SyntaxTree tree)
    {
        if (!_models.TryGetValue(tree, out var model)) _models[tree] = model = _compilation.GetSemanticModel(tree);
        return model;
    }

    private static bool InRuleFiles(SyntaxTree tree) => RuleFiles.Any(f => tree.FilePath.EndsWith(Path.DirectorySeparatorChar + "Requests" + Path.DirectorySeparatorChar + f, StringComparison.Ordinal));

    /// <summary>The rule: <c>RequestDestination</c>'s members, and <c>MutationInput.Extra</c> (which asks it).</summary>
    internal static bool IsRule(ISymbol? symbol)
        => symbol is IMethodSymbol m && (m.ContainingType?.Name == "RequestDestination" || (m.ContainingType?.Name == "MutationInput" && m.Name == "Extra"));

    private static bool IsProtected(ISymbol? symbol)
        => symbol is IPropertySymbol or IFieldSymbol or IMethodSymbol && symbol.ContainingType != null &&
           Protected.TryGetValue(symbol.ContainingType.Name, out var members) && members.Contains(symbol.Name);

    // Calls that pick one element of a collection.
    private static readonly HashSet<string> Picks = new(StringComparer.Ordinal)
    {
        "First", "FirstOrDefault", "Last", "LastOrDefault", "Single", "SingleOrDefault", "ElementAt", "ElementAtOrDefault", "MinBy", "MaxBy", "Min", "Max",
    };

    // One request (not a collection of them).
    private static bool IsOneRequest(ITypeSymbol? type) => type != null && type is not IArrayTypeSymbol && RequestTypes.Contains(type.Name);

    private static bool IsRequestType(ITypeSymbol? type)
    {
        if (type == null) return false;
        if (RequestTypes.Contains(type.Name)) return true;
        if (type is IArrayTypeSymbol array) return IsRequestType(array.ElementType);
        return type is INamedTypeSymbol named && named.TypeArguments.Any(IsRequestType);
    }

    /// <summary>One comparison or selection outside the rule.</summary>
    /// <param name="File">The rule file.</param>
    /// <param name="Member">The member it is in (Type.Member).</param>
    /// <param name="Code">The comparison's code, whitespace normalised.</param>
    /// <param name="Line">Its line (1-based).</param>
    /// <param name="Why">What it is.</param>
    internal sealed record Site(string File, string Member, string Code, int Line, string Why)
    {
        public override string ToString() => $"{File}:{Line} {Member}: {Why}: {Code}";
    }

    /// <summary>Every comparison or selection on a protected value outside the rule, in the rule files (or the ones named).</summary>
    internal List<Site> Raw(params string[] files) => Raw(null, files);

    /// <summary>The same in one member only (Type.Member), or everywhere when <paramref name="member"/> is null.</summary>
    internal List<Site> Raw(string? member, params string[] files)
    {
        var sites = new List<Site>();
        foreach (var file in files.Length == 0 ? RuleFiles : files)
        {
            var tree = Tree(Requests(file));
            var model = Model(tree);
            foreach (var body in Bodies(tree.GetRoot()).Where(b => member == null || MemberOf(b) == member))
            {
                var flow = new Flow(this, model, body, Seeded(model, body));
                foreach (var (node, why) in flow.Sites(depth: 0))
                    sites.Add(new Site(file, MemberOf(node), Normal(node), node.GetLocation().GetLineSpan().StartLinePosition.Line + 1, why));
            }
        }
        return sites;
    }

    // Within the rule files a protected value is followed into the methods it is given to: their parameters that receive one
    // at any call there, and the parameters of a delegate (a lambda given to such a method) the method calls with one.
    private Dictionary<IMethodSymbol, HashSet<int>>? _seeds;
    private readonly Dictionary<(IMethodSymbol Method, int Parameter), HashSet<int>> _delegateSeeds = new();

    private HashSet<IParameterSymbol> Seeded(SemanticModel model, SyntaxNode body)
    {
        var seeds = Seeds();
        var seeded = new HashSet<IParameterSymbol>(SymbolEqualityComparer.Default);
        foreach (var declared in body.DescendantNodesAndSelf().Where(n => n is BaseMethodDeclarationSyntax or LocalFunctionStatementSyntax).Select(n => model.GetDeclaredSymbol(n)).OfType<IMethodSymbol>())
        {
            var positions = _inherited is { } inherited ? inherited.Seeds.GetValueOrDefault(Key(declared)) : seeds.GetValueOrDefault(declared);
            foreach (var i in positions ?? new HashSet<int>()) if (i < declared.Parameters.Length) seeded.Add(declared.Parameters[i]);
        }
        return seeded;
    }

    private Dictionary<IMethodSymbol, HashSet<int>> Seeds()
    {
        if (_seeds != null) return _seeds;
        _seeds = new Dictionary<IMethodSymbol, HashSet<int>>(SymbolEqualityComparer.Default);
        if (_inherited != null) return _seeds;
        for (var round = 0; round < 8; round++)
        {
            var changed = false;
            foreach (var file in RuleFiles)
            {
                var tree = Tree(Requests(file));
                var model = Model(tree);
                foreach (var body in Bodies(tree.GetRoot()))
                {
                    var flow = new Flow(this, model, body, Seeded(model, body));
                    foreach (var call in body.DescendantNodes().OfType<InvocationExpressionSyntax>())
                    {
                        var symbol = model.GetSymbolInfo(call).Symbol;
                        var args = call.ArgumentList.Arguments;
                        if (symbol is IMethodSymbol target && !IsRule(target) && (target.ReducedFrom ?? target).OriginalDefinition is { } method &&
                            method.DeclaringSyntaxReferences.Any(r => InRuleFiles(r.SyntaxTree)))
                        {
                            for (var i = 0; i < args.Count; i++)
                            {
                                var parameter = args[i].NameColon is { } named ? method.Parameters.FirstOrDefault(p => p.Name == named.Name.Identifier.Text) : i < method.Parameters.Length ? method.Parameters[i] : method.Parameters.LastOrDefault(p => p.IsParams);
                                if (parameter == null || !flow.Eval(args[i].Expression).Tainted) continue;
                                if (!_seeds.TryGetValue(method, out var set)) _seeds[method] = set = new HashSet<int>();
                                changed |= set.Add(parameter.Ordinal);
                            }
                        }
                        // A delegate parameter called with a protected value.
                        if (symbol is IMethodSymbol { MethodKind: MethodKind.DelegateInvoke } && call.Expression is IdentifierNameSyntax name &&
                            model.GetSymbolInfo(name).Symbol is IParameterSymbol { ContainingSymbol: IMethodSymbol owner } delegateParameter)
                        {
                            for (var i = 0; i < args.Count; i++)
                            {
                                if (!flow.Eval(args[i].Expression).Tainted) continue;
                                var key = (owner.OriginalDefinition, delegateParameter.Ordinal);
                                if (!_delegateSeeds.TryGetValue(key, out var set)) _delegateSeeds[key] = set = new HashSet<int>();
                                changed |= set.Add(i);
                            }
                        }
                    }
                }
            }
            if (!changed) break;
        }
        return _seeds;
    }

    // The lambda parameters given a protected value: the lambda is passed for a delegate parameter its method calls with one.
    private bool LambdaSeeded(SemanticModel model, LambdaExpressionSyntax lambda, int position)
    {
        if ((_seeds == null && _inherited == null) || lambda.Parent is not ArgumentSyntax { Parent: ArgumentListSyntax { Parent: InvocationExpressionSyntax call } list } argument) return false;
        if (model.GetSymbolInfo(call).Symbol is not IMethodSymbol method) return false;
        method = (method.ReducedFrom ?? method).OriginalDefinition;
        var index = list.Arguments.IndexOf(argument);
        var parameter = argument.NameColon is { } named ? method.Parameters.FirstOrDefault(p => p.Name == named.Name.Identifier.Text) : index < method.Parameters.Length ? method.Parameters[index] : null;
        if (parameter == null) return false;
        var positions = _inherited is { } inherited ? inherited.Delegates.GetValueOrDefault((Key(method), parameter.Ordinal)) : _delegateSeeds.GetValueOrDefault((method, parameter.Ordinal));
        return positions?.Contains(position) == true;
    }

    /// <summary>Calls to the rule per member of the rule files (Type.Member → rule member names, sorted).</summary>
    internal Dictionary<string, List<string>> RuleCalls(params string[] files) => RuleCalls(null, files);

    /// <summary>The same for one member only, or every member when <paramref name="member"/> is null.</summary>
    internal Dictionary<string, List<string>> RuleCalls(string? member, params string[] files)
    {
        var calls = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var site in RuleSites(member, files))
        {
            if (!calls.TryGetValue(site.Member, out var list)) calls[site.Member] = list = new List<string>();
            list.Add(site.Rule);
        }
        foreach (var list in calls.Values) list.Sort(StringComparer.Ordinal);
        return calls;
    }

    /// <summary>One call to the rule in a rule file, with the code that would take it out (A) or do it without the rule (B).</summary>
    internal sealed record RuleSite(string File, string Member, string Rule, int Line, TextSpan Span, string Code, string Without, string? Raw);

    /// <summary>Every call to the rule in the rule files.</summary>
    internal List<RuleSite> RuleSites(params string[] files) => RuleSites(null, files);

    private List<RuleSite> RuleSites(string? member, params string[] files)
    {
        var sites = new List<RuleSite>();
        foreach (var file in files.Length == 0 ? RuleFiles : files)
        {
            var tree = Tree(Requests(file));
            var model = Model(tree);
            foreach (var call in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (member != null && MemberOf(call) != member) continue;
                if (model.GetSymbolInfo(call).Symbol is not IMethodSymbol method || !IsRule(method)) continue;
                var args = call.ArgumentList.Arguments.Select(a => "(" + a.Expression + ")").ToList();
                var receiver = call.Expression is MemberAccessExpressionSyntax access && method.Name == "Extra" ? "(" + access.Expression + ")" : null;
                // A: the filtering taken out. B: the same done by a raw comparison (null where there is no natural one).
                var (without, raw) = method.Name switch
                {
                    "Extra" => ("((MutationInput?)null)", $"({args[0]}.Any(i => i.Seasons.SequenceEqual({receiver}.Seasons)) ? null : {receiver})"),
                    "Of" => (args[0], (string?)null),
                    "Approval" => ("default(RequestDestination.Verdict)", null),
                    "SameTarget" or "SamePlace" => ("true", $"{args[0]} == {args[1]}"),
                    "Serves" when args.Count == 4 => ("true", $"{args[1]} == {args[3]}"),
                    "Serves" => ("true", $"{args[1]}.InstanceId == {args[0]}.InstanceId"),
                    "SameOptions" => ("true", $"{args[0]}.SeerrRootFolder == {args[1]}.SeerrRootFolder"),
                    "RoutingChanged" => ("false", $"{args[0]}.InstanceId != {args[1]}.InstanceId"),
                    "SeerrHas" => ("true", $"{args[0]}.SeerrServerId == {args[1]}"),
                    "SameTitle" => ("true", $"{args[0]}.Key == {args[1]}.Key"),
                    "SameEdition" => ("true", $"{args[0]}.Key == {args[1]}.Key && {args[0]}.Variant == {args[1]}.Variant"),
                    "Edition" => ("(Key: \"\", Variant: \"\")", $"(Key: {args[0]}.Key, Variant: {args[0]}.Variant)"),
                    _ => ("default", (string?)null),
                };
                sites.Add(new RuleSite(file, MemberOf(call), method.Name, call.GetLocation().GetLineSpan().StartLinePosition.Line + 1, call.Span, call.ToString(), "(" + without + ")", raw == null ? null : "(" + raw + ")"));
            }
        }
        return sites;
    }

    /// <summary>The plugin with one rule call's text replaced.</summary>
    internal DestinationRuleWalk Replace(RuleSite site, string code)
        => With(Requests(site.File), text => text[..site.Span.Start] + code + text[site.Span.End..]);

    /// <summary>
    /// Null when <c>MutationInput.Extra</c> asks the rule before anything else: its <c>covered</c> parameter is used once,
    /// filtered by <c>RequestDestination.Serves(this, …)</c>, and it reads no routing itself. Else what is wrong.
    /// </summary>
    internal string? ExtraProblem()
    {
        var tree = Tree(Requests("RequestModels.cs"));
        var model = Model(tree);
        var extra = tree.GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>().Single(m => m.Identifier.Text == "Extra" && m.Parent is TypeDeclarationSyntax { Identifier.Text: "MutationInput" });
        var covered = model.GetDeclaredSymbol(extra.ParameterList.Parameters.Single())!;
        var uses = extra.DescendantNodes().OfType<IdentifierNameSyntax>().Where(i => SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(i).Symbol, covered)).ToList();
        if (uses.Count != 1) return "covered is used " + uses.Count + " times";
        if (uses[0].Parent is not MemberAccessExpressionSyntax { Name.Identifier.Text: "Where" } where || where.Parent is not InvocationExpressionSyntax call ||
            call.ArgumentList.Arguments.SingleOrDefault()?.Expression is not SimpleLambdaExpressionSyntax { ExpressionBody: InvocationExpressionSyntax serves } lambda ||
            model.GetSymbolInfo(serves).Symbol is not IMethodSymbol { Name: "Serves", ContainingType.Name: "RequestDestination" } ||
            serves.ArgumentList.Arguments.Count != 2 || serves.ArgumentList.Arguments[0].Expression is not ThisExpressionSyntax ||
            serves.ArgumentList.Arguments[1].Expression is not IdentifierNameSyntax other || other.Identifier.Text != lambda.Parameter.Identifier.Text)
            return "covered isn't filtered by RequestDestination.Serves(this, c): " + uses[0].Parent?.Parent;
        var routing = extra.DescendantNodes().OfType<SimpleNameSyntax>().Select(n => model.GetSymbolInfo(n).Symbol)
            .FirstOrDefault(s => s is IPropertySymbol { ContainingType.Name: "MutationInput" } p && p.Name is "InstanceId" or "ProfileId" or "RootFolder" or "SeerrServerId" or "SeerrProfileId" or "SeerrRootFolder" or "SeerrOptions" ||
                s is IMethodSymbol { ContainingType.Name: "BridgePaths" });
        return routing == null ? null : "Extra reads routing itself: " + routing.Name;
    }

    /// <summary>
    /// True when the local <paramref name="local"/> of <paramref name="member"/> (Type.Member) in a rule file is built by a
    /// call to the rule member <paramref name="rule"/> (the collection an allowed selection picks from).
    /// </summary>
    internal bool BuiltThrough(string file, string member, string local, string rule)
    {
        var tree = Tree(Requests(file));
        var model = Model(tree);
        return tree.GetRoot().DescendantNodes().OfType<VariableDeclaratorSyntax>()
            .Where(d => d.Identifier.Text == local && MemberOf(d) == member && d.Initializer != null)
            .Any(d => d.Initializer!.DescendantNodes().OfType<InvocationExpressionSyntax>().Any(i => model.GetSymbolInfo(i).Symbol is IMethodSymbol m && IsRule(m) && m.Name == rule));
    }

    // A SQL lookup by title key ("title_key=$key", "w.title_key IN (…)"), not an assignment ("SET title_key=…").
    private static readonly System.Text.RegularExpressions.Regex TitleLookup = new(@"(?<!SET\s)\b(?:\w+\.)?title_key\s*(?:=\s*\$|IN\s*\()", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    /// <summary>
    /// SQL in the rule files that looks a title up by a key as given (not through <c>RequestLedger.TitleIs</c>, which resolves
    /// the title's aliases first): (member, the literal).
    /// </summary>
    internal List<(string File, string Member, string Sql)> RawTitleLookups(params string[] files)
    {
        var found = new List<(string, string, string)>();
        foreach (var file in files.Length == 0 ? RuleFiles : files)
        {
            var root = Tree(Requests(file)).GetRoot();
            foreach (var token in root.DescendantTokens().Where(t => t.IsKind(SyntaxKind.StringLiteralToken) || t.IsKind(SyntaxKind.InterpolatedStringTextToken)))
                if (TitleLookup.IsMatch(token.ValueText)) found.Add((file, MemberOf(token.Parent!), token.ValueText));
        }
        return found;
    }

    /// <summary>True when Seerr's own record of a request is matched through the rule (<c>RequestDestination.SeerrHas</c>).</summary>
    internal bool SeerrRecordThroughTheRule()
    {
        var tree = Tree(Requests("SeerrBackend.cs"));
        var model = Model(tree);
        var same = tree.GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>().Single(m => m.Identifier.Text == "SameOptions");
        return same.ExpressionBody?.Expression is InvocationExpressionSyntax call && model.GetSymbolInfo(call).Symbol is IMethodSymbol { Name: "SeerrHas", ContainingType.Name: "RequestDestination" };
    }

    // Every body of code: methods, constructors, accessors, local functions are inside them; field initialisers too.
    private static IEnumerable<SyntaxNode> Bodies(SyntaxNode root)
        => root.DescendantNodes().Where(n => n is BaseMethodDeclarationSyntax or AccessorDeclarationSyntax or ArrowExpressionClauseSyntax { Parent: PropertyDeclarationSyntax or IndexerDeclarationSyntax }
            or EqualsValueClauseSyntax { Parent: VariableDeclaratorSyntax { Parent.Parent: FieldDeclarationSyntax } } or EqualsValueClauseSyntax { Parent: PropertyDeclarationSyntax });

    private static string MemberOf(SyntaxNode node)
    {
        var member = node.AncestorsAndSelf().OfType<MemberDeclarationSyntax>().FirstOrDefault(m => m is not TypeDeclarationSyntax and not NamespaceDeclarationSyntax and not FileScopedNamespaceDeclarationSyntax);
        var type = node.Ancestors().OfType<TypeDeclarationSyntax>().FirstOrDefault()?.Identifier.Text ?? "?";
        var name = member switch
        {
            MethodDeclarationSyntax m => m.Identifier.Text,
            ConstructorDeclarationSyntax => ".ctor",
            PropertyDeclarationSyntax p => p.Identifier.Text,
            FieldDeclarationSyntax f => f.Declaration.Variables.First().Identifier.Text,
            IndexerDeclarationSyntax => "this[]",
            _ => "?",
        };
        return type + "." + name;
    }

    internal static string Normal(SyntaxNode node) => string.Join(" ", node.ToString().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    // ------------------------------------------------------------------ the flow of values in one body of code

    /// <summary>What a value is: whether it says where a request goes or what it asks for, and where it came from.</summary>
    private readonly record struct Value(bool Tainted, ImmutableSet Origins, bool Constant)
    {
        public static readonly Value None = new(false, ImmutableSet.Empty, false);
        public Value With(Value other) => new(Tainted || other.Tainted, Origins.Union(other.Origins), false);
    }

    /// <summary>
    /// One request taken from a collection: by index (<c>pair[0]</c>), or as an element a call picks (<c>list.First()</c>):
    /// the collection (its symbol, or the expression's text) and which element (the index, or the call and its arguments).
    /// The same element twice is one source; two elements of one collection are two (security-r5-2).
    /// </summary>
    private sealed record ElementOrigin(object Collection, string Selector);

    /// <summary>
    /// A small immutable set of where values came from: parameters, <c>this</c>, static members, each element of a loop or
    /// lambda (its variable), each call that fetches requests (the call itself), and each element taken from a collection.
    /// </summary>
    private sealed class ImmutableSet
    {
        public static readonly ImmutableSet Empty = new(Array.Empty<object>());
        private readonly object[] _items;
        private ImmutableSet(object[] items) => _items = items;
        public static ImmutableSet Of(object origin) => new(new[] { origin });
        public int Count => _items.Length;
        private static bool Same(object a, object b) => (a, b) switch
        {
            (ISymbol x, ISymbol y) => SymbolEqualityComparer.Default.Equals(x, y),
            (string x, string y) => string.Equals(x, y, StringComparison.Ordinal),
            (ElementOrigin x, ElementOrigin y) => Same(x.Collection, y.Collection) && string.Equals(x.Selector, y.Selector, StringComparison.Ordinal),
            _ => ReferenceEquals(a, b),
        };
        private static bool In(object item, object[] items) => items.Any(i => Same(i, item));
        public ImmutableSet Union(ImmutableSet other)
        {
            if (other._items.Length == 0) return this;
            if (_items.Length == 0) return other;
            var all = _items.ToList();
            foreach (var s in other._items) if (!In(s, all.ToArray())) all.Add(s);
            return all.Count == _items.Length ? this : new ImmutableSet(all.ToArray());
        }
        public bool SameAs(ImmutableSet other) => _items.Length == other._items.Length && _items.All(s => In(s, other._items));
    }

    private sealed class Flow
    {
        private readonly DestinationRuleWalk _walk;
        private readonly SemanticModel _model;
        private readonly SyntaxNode _body;
        private readonly HashSet<IParameterSymbol> _seeded;
        private readonly Dictionary<ISymbol, Value> _vars = new(SymbolEqualityComparer.Default);
        private readonly ISymbol _this;

        public Flow(DestinationRuleWalk walk, SemanticModel model, SyntaxNode body, HashSet<IParameterSymbol> seeded)
        {
            _walk = walk;
            _model = model;
            _body = body;
            _seeded = seeded;
            _this = body.AncestorsAndSelf().OfType<TypeDeclarationSyntax>().FirstOrDefault() is { } type && model.GetDeclaredSymbol(type) is { } declared ? declared : model.Compilation.ObjectType;
            Settle();
        }

        // Locals, lambda parameters, loop and pattern variables take the value they are given, until nothing changes.
        private void Settle()
        {
            for (var round = 0; round < 12; round++)
            {
                _memo.Clear();
                var changed = false;
                void Set(ISymbol? symbol, Value value)
                {
                    if (symbol == null) return;
                    var before = _vars.TryGetValue(symbol, out var known) ? known : (Value?)null;
                    var after = before is { } b ? b.With(value) : value with { Constant = false };
                    if (before is { } old && old.Tainted == after.Tainted && old.Origins.SameAs(after.Origins)) return;
                    _vars[symbol] = after;
                    changed = true;
                }
                foreach (var node in _body.DescendantNodesAndSelf())
                {
                    switch (node)
                    {
                        case VariableDeclaratorSyntax { Initializer: { } init } declarator:
                            Set(_model.GetDeclaredSymbol(declarator), Eval(init.Value));
                            break;
                        case AssignmentExpressionSyntax assignment when assignment.Left is IdentifierNameSyntax or DeclarationExpressionSyntax or TupleExpressionSyntax:
                            foreach (var target in Targets(assignment.Left)) Set(target, Eval(assignment.Right));
                            break;
                        case ForEachStatementSyntax loop:
                            Set(_model.GetDeclaredSymbol(loop), Element(Eval(loop.Expression), _model.GetDeclaredSymbol(loop)));
                            break;
                        case ForEachVariableStatementSyntax loop:
                            foreach (var target in Targets(loop.Variable)) Set(target, Element(Eval(loop.Expression), target));
                            break;
                        case SingleVariableDesignationSyntax designation when Tested(designation) is { } tested:
                            Set(_model.GetDeclaredSymbol(designation), Eval(tested));
                            break;
                        case LambdaExpressionSyntax lambda:
                            var source = Source(lambda);
                            var position = 0;
                            foreach (var parameter in Parameters(lambda))
                            {
                                var symbol = _model.GetDeclaredSymbol(parameter);
                                var seededByCaller = _walk.LambdaSeeded(_model, lambda, position++);
                                if (symbol != null) Set(symbol, Element(source is { } s ? Eval(s) : new Value(seededByCaller, ImmutableSet.Empty, false), symbol) with { Tainted = seededByCaller || (source is { } t && Eval(t).Tainted) });
                            }
                            break;
                        case FromClauseSyntax from:
                            Set(_model.GetDeclaredSymbol(from), Element(Eval(from.Expression), _model.GetDeclaredSymbol(from)));
                            break;
                        case ArgumentSyntax { RefKindKeyword.Text: "out", Expression: DeclarationExpressionSyntax declared } argument when argument.Parent?.Parent is InvocationExpressionSyntax call:
                            foreach (var target in Targets(declared)) Set(target, Eval(call));
                            break;
                    }
                }
                if (!changed) break;
            }
            _memo.Clear();
        }

        // Each element of a collection is a value of its own (another request, another season), protected when it is.
        private static Value Element(Value collection, ISymbol? variable) => new(collection.Tainted, variable == null ? collection.Origins : ImmutableSet.Of(variable), false);

        private IEnumerable<ISymbol> Targets(ExpressionSyntax left) => left switch
        {
            IdentifierNameSyntax id => _model.GetSymbolInfo(id).Symbol is ILocalSymbol local ? new ISymbol[] { local } : Array.Empty<ISymbol>(),
            DeclarationExpressionSyntax declaration => declaration.Designation.DescendantNodesAndSelf().OfType<SingleVariableDesignationSyntax>().Select(d => _model.GetDeclaredSymbol(d)).OfType<ISymbol>(),
            TupleExpressionSyntax tuple => tuple.Arguments.SelectMany(a => Targets(a.Expression)),
            _ => Array.Empty<ISymbol>(),
        };

        // The expression a pattern variable is tested against.
        private static ExpressionSyntax? Tested(SyntaxNode designation)
        {
            foreach (var up in designation.Ancestors())
            {
                switch (up)
                {
                    case IsPatternExpressionSyntax isPattern: return isPattern.Expression;
                    case SwitchExpressionSyntax switchExpression: return switchExpression.GoverningExpression;
                    case SwitchStatementSyntax switchStatement: return switchStatement.Expression;
                    case StatementSyntax or LambdaExpressionSyntax: return null;
                }
            }
            return null;
        }

        private static IEnumerable<ParameterSyntax> Parameters(LambdaExpressionSyntax lambda) => lambda switch
        {
            SimpleLambdaExpressionSyntax simple => new[] { simple.Parameter },
            ParenthesizedLambdaExpressionSyntax parenthesized => parenthesized.ParameterList.Parameters,
            _ => Array.Empty<ParameterSyntax>(),
        };

        // The collection a lambda's parameters come from: the receiver of the LINQ-style call it is given to.
        private ExpressionSyntax? Source(LambdaExpressionSyntax lambda)
        {
            if (lambda.Parent is not ArgumentSyntax { Parent: ArgumentListSyntax { Parent: InvocationExpressionSyntax call } list }) return null;
            var method = _model.GetSymbolInfo(call).Symbol as IMethodSymbol;
            // x.Where(l), x.Any(l), list.Exists(l): the receiver; Enumerable.Where(x, l), Array.Find(x, l): the first argument.
            if (method is { IsStatic: true, ReducedFrom: null }) return list.Arguments.Count > 0 && list.Arguments[0].Expression != lambda ? list.Arguments[0].Expression : null;
            return call.Expression is MemberAccessExpressionSyntax receiver && _model.GetSymbolInfo(receiver.Expression).Symbol is not (ITypeSymbol or INamespaceSymbol) ? receiver.Expression : null;
        }

        private bool IsConstant(ExpressionSyntax e)
            => e is LiteralExpressionSyntax || e.IsKind(SyntaxKind.DefaultExpression) || _model.GetConstantValue(e).HasValue ||
               _model.GetSymbolInfo(e).Symbol is IFieldSymbol { IsConst: true } or ITypeSymbol or INamespaceSymbol;

        private readonly Dictionary<ExpressionSyntax, Value> _memo = new();

        public Value Eval(ExpressionSyntax e)
        {
            if (_memo.TryGetValue(e, out var known)) return known;
            return _memo[e] = Evaluate(e);
        }

        private Value Evaluate(ExpressionSyntax e)
        {
            if (IsConstant(e)) return new Value(false, ImmutableSet.Empty, true);
            var symbol = _model.GetSymbolInfo(e).Symbol;
            switch (e)
            {
                case ParenthesizedExpressionSyntax p: return Eval(p.Expression);
                case CastExpressionSyntax c: return Eval(c.Expression);
                case PostfixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression } bang: return Eval(bang.Operand);
                case ThisExpressionSyntax: return new Value(false, ImmutableSet.Of(_this), false);
                case IdentifierNameSyntax or GenericNameSyntax:
                    return symbol switch
                    {
                        ILocalSymbol or IRangeVariableSymbol => _vars.TryGetValue(symbol, out var v) ? v : Value.None,
                        IParameterSymbol parameter => _vars.TryGetValue(parameter, out var lambdaParameter) ? lambdaParameter : new Value(_seeded.Contains(parameter), ImmutableSet.Of(parameter), false),
                        IPropertySymbol or IFieldSymbol when !symbol.IsStatic => new Value(IsProtected(symbol), ImmutableSet.Of(_this), false),
                        IPropertySymbol or IFieldSymbol => new Value(IsProtected(symbol), ImmutableSet.Of(symbol), false),
                        _ => Value.None,
                    };
                case MemberAccessExpressionSyntax access:
                {
                    if (symbol is IMethodSymbol) return Eval(access.Expression);
                    var left = _model.GetSymbolInfo(access.Expression).Symbol is ITypeSymbol or INamespaceSymbol ? new Value(false, symbol == null ? ImmutableSet.Empty : ImmutableSet.Of(symbol), false) : Eval(access.Expression);
                    if (symbol?.ContainingType != null && Unprotected.TryGetValue(symbol.ContainingType.Name, out var plain) && plain.Contains(symbol.Name)) return left with { Tainted = false };
                    return new Value(left.Tainted || IsProtected(symbol), left.Origins, false);
                }
                case ConditionalAccessExpressionSyntax conditional:
                    return Eval(conditional.Expression).With(Bound(conditional.WhenNotNull, Eval(conditional.Expression)));
                case InvocationExpressionSyntax call:
                {
                    var parts = Value.None;
                    if (call.Expression is MemberAccessExpressionSyntax access && _model.GetSymbolInfo(access.Expression).Symbol is not (ITypeSymbol or INamespaceSymbol)) parts = parts.With(Eval(access.Expression));
                    foreach (var argument in call.ArgumentList.Arguments) parts = parts.With(Eval(argument.Expression));
                    // The rule's answer, and a comparison's, are not themselves a destination.
                    var answer = symbol is IMethodSymbol method && (IsRule(method) || (Comparing.Contains(method.Name) && method.ReturnType.SpecialType == SpecialType.System_Boolean));
                    // A database read (RequestLedger.Scalar) is a value of its own, whatever it was looked up by.
                    if (symbol is IMethodSymbol { Name: "Scalar", ContainingType.Name: "RequestLedger" }) return new Value(false, ImmutableSet.Of(call), false);
                    // One request picked from a collection (its first, last, nth…) is a source of its own: another pick is another request.
                    if (symbol is IMethodSymbol picked && Picks.Contains(picked.Name) && IsOneRequest(_model.GetTypeInfo(call).Type) &&
                        call.Expression is MemberAccessExpressionSyntax from && _model.GetSymbolInfo(from.Expression).Symbol is not (ITypeSymbol or INamespaceSymbol))
                        return new Value(false, ImmutableSet.Of(new ElementOrigin(Holder(from.Expression), picked.Name + "(" + string.Join(",", call.ArgumentList.Arguments.Select(a => Normal(a))) + ")")), false);
                    // Requests (fetched, filtered or derived) are requests, not a destination: their own members say that.
                    // Fetched ones (no receiver) are a source of their own; filtered or derived ones come from the receiver.
                    if (IsRequestType(_model.GetTypeInfo(call).Type) && !IsProtected(symbol))
                        return new Value(false, call.Expression is MemberAccessExpressionSyntax derived && _model.GetSymbolInfo(derived.Expression).Symbol is not (ITypeSymbol or INamespaceSymbol) ? Eval(derived.Expression).Origins : ImmutableSet.Of(call), false);
                    return new Value(!answer && (parts.Tainted || IsProtected(symbol)), parts.Origins, false);
                }
                case BinaryExpressionSyntax binary when IsComparison(binary):
                    return new Value(false, Eval(binary.Left).Origins.Union(Eval(binary.Right).Origins), false);
                // One request taken from a collection by index: a source of its own (pair[0] and pair[1] are two requests).
                case ElementAccessExpressionSyntax element when IsOneRequest(_model.GetTypeInfo(element).Type):
                    return new Value(Eval(element.Expression).Tainted, ImmutableSet.Of(new ElementOrigin(Holder(element.Expression), string.Join(",", element.ArgumentList.Arguments.Select(a => Index(a.Expression))))), false);
                case LambdaExpressionSyntax lambda:
                    return lambda.ExpressionBody is { } body ? Eval(body)
                        : lambda.Block?.DescendantNodes().OfType<ReturnStatementSyntax>().Where(r => r.Expression != null).Aggregate(Value.None, (v, r) => v.With(Eval(r.Expression!))) ?? Value.None;
                case AnonymousFunctionExpressionSyntax:
                    return Value.None;
            }
            // Anything else (arithmetic, conditionals, creations, tuples, with-expressions, interpolations…): what it is made of.
            var value = Value.None;
            foreach (var child in Children(e)) value = value.With(Eval(child));
            return value;
        }

        // The collection an element is taken from: its symbol (a local, parameter, field or property), else its text.
        private object Holder(ExpressionSyntax collection)
            => _model.GetSymbolInfo(collection).Symbol is ILocalSymbol or IParameterSymbol or IFieldSymbol or IPropertySymbol or IRangeVariableSymbol ? _model.GetSymbolInfo(collection).Symbol! : Normal(collection);

        // Which element an index names: a constant's value, a variable (by its declaration), else the index's text.
        private string Index(ExpressionSyntax index)
        {
            if (_model.GetConstantValue(index) is { HasValue: true } constant) return "=" + constant.Value;
            if (_model.GetSymbolInfo(index).Symbol is ILocalSymbol or IParameterSymbol or IRangeVariableSymbol)
            {
                var variable = _model.GetSymbolInfo(index).Symbol!;
                return variable.Name + "@" + variable.Locations.FirstOrDefault()?.SourceSpan.Start;
            }
            return Normal(index);
        }

        // .b, [i] or a call after ?. : the bound value's member.
        private Value Bound(ExpressionSyntax whenNotNull, Value bound)
        {
            var value = bound;
            foreach (var name in whenNotNull.DescendantNodesAndSelf().OfType<SimpleNameSyntax>())
                if (IsProtected(_model.GetSymbolInfo(name).Symbol)) value = value with { Tainted = true };
            return value;
        }

        private static IEnumerable<ExpressionSyntax> Children(SyntaxNode e)
            => e.ChildNodes().SelectMany(n => n is ExpressionSyntax x ? new[] { x } : Children(n));

        private static bool IsComparison(BinaryExpressionSyntax binary) => binary.Kind() is SyntaxKind.EqualsExpression or SyntaxKind.NotEqualsExpression or
            SyntaxKind.LessThanExpression or SyntaxKind.LessThanOrEqualExpression or SyntaxKind.GreaterThanExpression or SyntaxKind.GreaterThanOrEqualExpression;

        // A comparison between a protected value and a value from somewhere else (two values from one source are not).
        private bool Compares(IEnumerable<ExpressionSyntax> participants, bool elementIsAnother = false)
        {
            var values = participants.Where(p => !IsConstant(p)).Select(Eval).ToList();
            if (!values.Any(v => v.Tainted)) return false;
            if (elementIsAnother) return true;
            if (values.Count < 2) return false;
            return values.Any(v => v.Origins.Count == 0 || !v.Origins.SameAs(values[0].Origins));
        }

        /// <summary>Every comparison or selection on a protected value in this body, outside the rule.</summary>
        public IEnumerable<(SyntaxNode Node, string Why)> Sites(int depth)
        {
            foreach (var node in _body.DescendantNodesAndSelf())
            {
                switch (node)
                {
                    case BinaryExpressionSyntax binary when IsComparison(binary) && Compares(new[] { binary.Left, binary.Right }):
                        yield return (binary, "compares " + binary.OperatorToken.Text);
                        break;
                    case InvocationExpressionSyntax call:
                    {
                        if (_model.GetSymbolInfo(call).Symbol is not IMethodSymbol method || IsRule(method)) break;
                        var receiver = call.Expression is MemberAccessExpressionSyntax access && _model.GetSymbolInfo(access.Expression).Symbol is not (ITypeSymbol or INamespaceSymbol) ? access.Expression : null;
                        var arguments = call.ArgumentList.Arguments.Select(a => a.Expression).Where(a => a is not LambdaExpressionSyntax).ToList();
                        var lambdas = call.ArgumentList.Arguments.Select(a => a.Expression).OfType<LambdaExpressionSyntax>().ToList();
                        var participants = (receiver == null ? arguments : arguments.Prepend(receiver)).ToList();
                        if (Comparing.Contains(method.Name) && Compares(participants))
                        {
                            yield return (call, "compares with " + method.Name);
                            break;
                        }
                        if (Keyed.Contains(method.Name) && lambdas.Any(l => Eval(l).Tainted))
                        {
                            yield return (call, "groups or matches requests by it with " + method.Name);
                            break;
                        }
                        if (method.Name == "SelectMany" && lambdas.Any(l => Eval(l).Tainted))
                        {
                            yield return (call, "merges it across requests with SelectMany");
                            break;
                        }
                        // A method group of a comparing call (x.Any(set.Contains)): each element against the group's receiver.
                        foreach (var group in arguments.OfType<MemberAccessExpressionSyntax>())
                        {
                            if (_model.GetSymbolInfo(group).Symbol is IMethodSymbol g && Comparing.Contains(g.Name) && Compares(new[] { group.Expression }, elementIsAnother: true))
                                yield return (group, "compares each element with " + g.Name);
                        }
                        // A plugin helper outside these files that compares what it is given.
                        var given = call.ArgumentList.Arguments.Select(a => a.Expression).ToList();
                        if (receiver != null) given.Insert(0, receiver);
                        if (depth < 4 && _walk.Helper(method, given.Select(Eval).ToList(), given.Select(p => _model.GetTypeInfo(p).Type).ToList(), receiver != null, depth) is { } via)
                            yield return (call, "via " + via);
                        break;
                    }
                    case ElementAccessExpressionSyntax element when element.ArgumentList.Arguments.Any(a => Eval(a.Expression).Tainted) && _model.GetTypeInfo(element.Expression).Type is not IArrayTypeSymbol:
                        yield return (element, "looks it up as a key");
                        break;
                }
            }
        }
    }

    // A plugin method outside the rule files, given these values: what in it (or in what it calls) compares them; null if nothing.
    private string? Helper(IMethodSymbol method, List<Value> values, List<ITypeSymbol?> types, bool hasReceiver, int depth)
    {
        method = method.ReducedFrom ?? method;
        if (IsRule(method) || method.DeclaringSyntaxReferences.Length == 0) return null;
        var declaration = method.DeclaringSyntaxReferences[0].GetSyntax();
        if (InRuleFiles(declaration.SyntaxTree) || declaration is not (MethodDeclarationSyntax or LocalFunctionStatementSyntax or ConstructorDeclarationSyntax)) return null;
        if (!values.Any(v => v.Tainted) && !types.Any(IsRequestType)) return null;
        // Which parameters receive a protected value (an extension method's receiver is its first parameter).
        var mask = 0;
        var offset = hasReceiver && method.IsExtensionMethod ? 0 : hasReceiver ? 1 : 0;
        for (var i = 0; i < values.Count; i++)
        {
            var index = i - offset;
            if (values[i].Tainted && index >= 0 && index < method.Parameters.Length && index < 30) mask |= 1 << index;
        }
        if (_helpers.TryGetValue((method, mask), out var known)) return known;
        _helpers[(method, mask)] = null;
        var seeded = new HashSet<IParameterSymbol>(method.Parameters.Where((p, i) => (mask & (1 << i)) != 0), SymbolEqualityComparer.Default);
        var model = Model(declaration.SyntaxTree);
        var flow = new Flow(this, model, declaration, seeded);
        var first = flow.Sites(depth + 1).Select(s => (s.Node, s.Why)).FirstOrDefault();
        var found = first.Node == null ? null : method.ContainingType.Name + "." + method.Name + " (" + first.Why + ": " + Normal(first.Node) + ")";
        _helpers[(method, mask)] = found;
        return found;
    }
}
