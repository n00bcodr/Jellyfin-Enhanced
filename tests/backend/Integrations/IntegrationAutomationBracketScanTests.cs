using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace JE.Tests;

/// <summary>
/// 4a review round 8 (4a-security-r8-3): every change to a source a versioned fact of the automatic-write check depends on
/// is made inside a version bracket (FactVersion.Mutate, AcquireDatabase.WriteAutomation, JellyfinUserVersions.Mutate):
/// odd before the change can be seen, even after. Round 9 (4a-security-r9-2): inside the RIGHT bracket. Round 8's scan
/// accepted any bracket by its method name, so <c>_otherFiles.Mutate(…)</c> around a settings file (a version the check
/// never samples) passed, and so did an unrelated FactVersion around an automation-table write.
/// <para>
/// The scan compiles the plugin's source and finds every writer by what it writes (by symbols, not names), each with the
/// version source it needs and, for a person's source, its key:
/// <list type="bullet">
/// <item><description>automation (every SQL write of automation_budget, automation_breakers or automation_grants, and a restore's copy
/// into the live database): AcquireDatabase.WriteAutomation, or AcquireDatabase.Automation;</description></item>
/// <item><description>person_settings (every file change where people's settings files are written, except temporary files and the
/// shared files listed with their reason): the person's version (UserConfigurationManager.VersionOf or its
/// _settingsVersions.For) keyed by the same person and file as the path changed, or every person's (AllSettingsVersion);</description></item>
/// <item><description>secrets (the secrets store's file and its values in memory): that store's own Version;</description></item>
/// <item><description>jellyfin_user (every call JE makes that can change or authenticate a Jellyfin user,
/// <see cref="JellyfinUserActions.Mutates"/>): JellyfinUserVersions.Mutate keyed by the same user, or MutateAll.</description></item>
/// </list>
/// A writer is inside a bracket when it is in a lambda (or a method group) handed to one, or in a method every call of
/// which is. The bracket's version source is resolved by <see cref="SemanticFlow"/>: through local aliases, <c>this.</c>,
/// helper methods and properties that return it, and parameters (to every argument passed). Every origin must be the
/// required source; its key arguments must be built from the same symbols as the write's target.
/// </para>
/// </summary>
public class IntegrationAutomationBracketScanTests
{
    private const string Users = "Configuration/UserConfigurationManager.cs";
    private const string Backup = "Services/Backup/JeBackupService.cs";
    private const string Secrets = "Services/Secrets/SecretsStore.cs";
    private const string Database = "Services/Acquire/AcquireDatabase.cs";

    // The bracket calls ("Type.Member").
    private static readonly HashSet<string> Brackets = new(StringComparer.Ordinal)
    {
        "FactVersion.Mutate", "FactVersion.MutateAsync", "AcquireDatabase.WriteAutomation", "JellyfinUserVersions.Mutate", "JellyfinUserVersions.MutateAll",
    };

    // The members a bracket's FactVersion may come from, with the source each is ("Type.Member").
    private static readonly Dictionary<string, string> Accessors = new(StringComparer.Ordinal)
    {
        ["AcquireDatabase.Automation"] = "automation",
        ["UserConfigurationManager.VersionOf"] = "person_settings",
        ["UserConfigurationManager._allSettingsVersion"] = "person_settings",
        ["UserConfigurationManager.AllSettingsVersion"] = "person_settings",
        ["FactVersions.For"] = "person_settings", // only on UserConfigurationManager._settingsVersions (checked)
        ["SecretsStore.Version"] = "secrets",
    };

    // A write of the automation tables the check reads.
    private static readonly Regex AutomationWrite = new(@"\b(INSERT(\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+automation_(budget|breakers|grants)\b", RegexOptions.IgnoreCase);

    // Files changed where per-person files live that aren't a person's settings: the shared reviews and activity files.
    private static readonly Dictionary<string, string> SharedFiles = new(StringComparer.Ordinal)
    {
        ["WriteStoreUnlocked"] = "reviews.json (shared, not a person's settings)",
        ["BackupCorruptFileUnlocked"] = "a copy of reviews.json before it is replaced",
        ["WriteActivityStoreUnlocked"] = "the shared activity file",
    };

    private static readonly string[] FileChanges = { "Move", "Copy", "Delete", "WriteAllText", "WriteAllBytes", "WriteAllLines", "AppendAllText", "AppendAllLines", "Replace", "Create", "CreateText", "AppendText", "OpenWrite" };

    // Round 10 (4a-security-r10-3): every file change in the plugin, whichever source file makes it. File and Directory's
    // own (above, plus WriteAllTextAsync and the like, and File.Open), a FileInfo's or DirectoryInfo's, and a FileStream or
    // StreamWriter opened on a path.
    private static readonly string[] AsyncFileChanges = { "WriteAllTextAsync", "WriteAllBytesAsync", "WriteAllLinesAsync", "AppendAllTextAsync", "AppendAllLinesAsync" };
    private static readonly string[] InfoChanges = { "MoveTo", "CopyTo", "Delete", "Create", "CreateText", "AppendText", "OpenWrite", "Replace", "Open" };
    private static readonly string[] Streams = { "FileStream", "StreamWriter" };

    // Where people's settings can be: anything built from Jellyfin's data folder, its plugins folder or the plugin
    // configurations folder (JE's own configuration folder, with each person's folder, is inside them).
    private static readonly HashSet<string> SettingsArea = new(StringComparer.Ordinal)
    {
        "IApplicationPaths.ProgramDataPath", "IApplicationPaths.PluginsPath", "IApplicationPaths.PluginConfigurationsPath", "IApplicationPaths.DataPath",
        "BasePlugin.DataFolderPath", "IPlugin.DataFolderPath",
    };

    // Reviewed: the files and folders JE writes inside that area that are nobody's settings, each by the member that
    // names it. A path built from one of these is that file (or a file in that folder), not a person's settings.
    internal static readonly Dictionary<string, string> NotPeoplesSettings = new(StringComparer.Ordinal)
    {
        ["SecretsStore._path"] = "the secrets file (the secrets source: its own version, checked as secrets above)",
        ["AcquireDatabase._path"] = "the request database and its copies (the automation source, checked as automation above)",
        ["ArrAuditLog._path"] = "the Sonarr/Radarr audit log",
        ["ArrStateStore._cacheDirectory"] = "the arr instances' warm-start library caches (arr-cache/*.library.json)",
        ["CatchUpLogService._livePath"] = "the catch-up log",
        ["CatchUpLogService._rotatedPath"] = "the catch-up log's previous file",
        ["MaintenanceModeService._stateFilePath"] = "maintenance mode's state",
        ["MdblistService.CacheFilePath"] = "the MDBList ratings cache",
        ["NativeDetailsArtwork.KeyFile"] = "the native details artwork grant key",
        ["NativeDetailsPolicy.EpochFile"] = "the native details sign-out epochs",
        ["PosterTagVariantToken._secretPath"] = "the poster tag variant token secret",
        ["TagCacheService.CacheFilePath"] = "the tag cache",
        ["TmdbResponseCache._diskPath"] = "the TMDB response cache",
        ["UsageEventCounterService.CacheFilePath"] = "the usage counters",
        ["WhatsNewService.SnapshotFilePath"] = "the What's New settings snapshot",
        ["WhatsNewService.WhatsNewFilePath"] = "the What's New state",
        ["WikidataAwardsService.CacheFilePath"] = "the Wikidata awards cache",
        ["DoesTheDogDieService.CacheFilePath"] = "the DoesTheDogDie warnings cache",
        ["ListStore.DirectoryPath"] = "the lists folder (list documents, the experimental importer's quarantine copies, collage markers and reports)",
        ["ListStore._dir"] = "the lists folder (list documents)",
        ["JeBackupService.DefaultFolderName"] = "the backups folder (backup zips and pre-restore copies)",
    };

    // Reviewed writers whose path is built in place from the data folder (no member names the file), by method.
    internal static readonly Dictionary<string, string> NotPeoplesSettingsWriters = new(StringComparer.Ordinal)
    {
        ["JellyfinEnhanced.CheckPluginPages"] = "the Plugin Pages plugin's own config.json (configurations/Jellyfin.Plugin.PluginPages)",
    };

    // One writer: what it is, the source it needs, and the expression its key must match (null: any).
    private sealed record Writer(SyntaxNode Node, SemanticModel Model, string What, string Source, ExpressionSyntax? Target);

    // A bracket around a writer: its source (null: not one this scan knows) and its key arguments (empty: every person's).
    private sealed record Bracket(string? Source, IReadOnlyList<(ExpressionSyntax Key, SemanticModel Model, object? Frame)> Keys, string Description);

    /// <summary>Every writer of a versioned source that isn't inside its bracket ("file:line: what").</summary>
    internal static List<string> Unbracketed(WriteGateWalk walk)
    {
        var scan = new Scan(walk);
        var problems = new List<string>();
        foreach (var writer in Writers(walk))
            if (scan.Problem(writer) is { } problem) problems.Add(Where(writer.Node) + ": " + writer.What + ": " + problem + ": " + Line(writer.Node));
        return problems;
    }

    private static IEnumerable<Writer> Writers(WriteGateWalk walk)
    {
        var area = new Area(walk);
        foreach (var (tree, model) in walk.Sources())
        {
            var file = Relative(tree);
            var root = tree.GetRoot();
            // The automation tables.
            foreach (var token in root.DescendantTokens().Where(t => t.IsKind(SyntaxKind.StringLiteralToken) || t.IsKind(SyntaxKind.InterpolatedStringTextToken)))
                if (AutomationWrite.IsMatch(token.ValueText))
                    yield return new Writer(token.Parent!, model, "a write of the automation tables", "automation", null);
            foreach (var call in root.DescendantNodes().OfType<InvocationExpressionSyntax>().Where(c => Candidate(c, file)))
            {
                if (model.GetSymbolInfo(call).Symbol is not IMethodSymbol method) continue;
                method = method.ReducedFrom ?? method;
                var space = method.ContainingNamespace?.ToDisplayString();
                var args = call.ArgumentList.Arguments;
                // A restore's copy into the live database.
                if (file == Database && method.Name == "BackupDatabase" && Enclosing(call) == "ReplaceWith")
                    yield return new Writer(call, model, "the restore's copy", "automation", null);
                // People's settings files, wherever the change is made: the path changed (a move's or copy's destination) is
                // the key. In UserConfigurationManager and a restore every file change counts (round 8); elsewhere one whose
                // path is built from the settings area (round 10), followed through helpers and their callers' arguments.
                if (FileChange(call, method, model) is { } changed && !Temporary(changed)
                    && !(file == Users && SharedFiles.ContainsKey(Enclosing(call) ?? string.Empty))
                    && (file is Users || (file == Backup && Enclosing(call) == "Restore") || (!ReviewedWriter(call, model) && area.Settings(changed, model))))
                    yield return new Writer(call, model, "a settings file change", "person_settings", changed);
                // A Jellyfin user change or sign-in: the user (its id, or the user itself) is the key.
                if (method.ContainingType is { } type && JellyfinUserActions.Mutates(Metadata(type), method.MetadataName))
                    yield return new Writer(call, model, "a Jellyfin user change (" + type.Name + "." + method.Name + ")", "jellyfin_user", args.FirstOrDefault()?.Expression);
                // The secrets file.
                if (file == Secrets && space == "System.IO" && method.ContainingType!.Name == "File" && FileChanges.Contains(method.Name) && !Temporary(call, method))
                    yield return new Writer(call, model, "a secrets file change", "secrets", null);
            }
            // A FileStream or StreamWriter opened on a path in the settings area.
            foreach (var creation in root.DescendantNodes().OfType<BaseObjectCreationExpressionSyntax>().Where(c => c is ImplicitObjectCreationExpressionSyntax || c is ObjectCreationExpressionSyntax { Type: var t } && Streams.Any(n => t.ToString().EndsWith(n, StringComparison.Ordinal))))
                if (model.GetTypeInfo(creation).Type is INamedTypeSymbol { Name: "FileStream" or "StreamWriter", ContainingNamespace: var ns } && ns.ToDisplayString() == "System.IO"
                    && creation.ArgumentList?.Arguments.FirstOrDefault()?.Expression is { } path && model.GetTypeInfo(path).Type?.SpecialType == SpecialType.System_String
                    && !Temporary(path) && !ReadOnlyStream(creation, model) && (file is Users || (!ReviewedWriter(creation, model) && area.Settings(path, model))))
                    yield return new Writer(creation, model, "a settings file change", "person_settings", path);
            // A Jellyfin user entity's members set.
            foreach (var assign in root.DescendantNodes().OfType<AssignmentExpressionSyntax>())
                if (model.GetSymbolInfo(assign.Left).Symbol is IPropertySymbol { ContainingType: { } owner, SetMethod: { } setter } && JellyfinUserActions.Mutates(Metadata(owner), setter.MetadataName))
                    yield return new Writer(assign, model, "a Jellyfin user entity changed", "jellyfin_user", (assign.Left as MemberAccessExpressionSyntax)?.Expression);
            // The secrets in memory.
            if (file == Secrets)
                foreach (var assign in root.DescendantNodes().OfType<AssignmentExpressionSyntax>().Where(a => model.GetSymbolInfo(a.Left).Symbol is IFieldSymbol { Name: "_values" }))
                    yield return new Writer(assign, model, "the stored secrets replaced", "secrets", null);
        }
    }

    // The metadata full name of a type (Namespace.Type, nested with '+', generic arity), as JellyfinUserActions names them.
    private static string Metadata(INamedTypeSymbol type)
    {
        var name = type.MetadataName;
        for (var outer = type.ContainingType; outer != null; outer = outer.ContainingType) name = outer.MetadataName + "+" + name;
        var space = type.ContainingNamespace?.IsGlobalNamespace == false ? type.ContainingNamespace.ToDisplayString() + "." : string.Empty;
        return space + name;
    }

    // Only calls that could be one of the writers are bound (by the name called): binding every call of the plugin is slow.
    private static bool Candidate(InvocationExpressionSyntax call, string file)
    {
        var name = call.Expression switch
        {
            MemberAccessExpressionSyntax access => access.Name.Identifier.ValueText,
            MemberBindingExpressionSyntax binding => binding.Name.Identifier.ValueText,
            IdentifierNameSyntax id => id.Identifier.ValueText,
            _ => string.Empty,
        };
        return name == "BackupDatabase" || UserChanges.Contains(name) || FileChanges.Contains(name) || AsyncFileChanges.Contains(name) || InfoChanges.Contains(name);
    }

    // The names of every member JellyfinUserActions.Mutates counts on IUserManager, ISessionManager, IQuickConnect, the
    // providers and the user entity, read from those types (so a new one is a candidate without a change here).
    private static readonly HashSet<string> UserChanges = UserChangeNames();

    private static HashSet<string> UserChangeNames()
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var type in new[] { typeof(MediaBrowser.Controller.Library.IUserManager), typeof(MediaBrowser.Controller.Session.ISessionManager), typeof(MediaBrowser.Controller.QuickConnect.IQuickConnect),
                     typeof(MediaBrowser.Controller.Authentication.IAuthenticationProvider), typeof(MediaBrowser.Controller.Authentication.IPasswordResetProvider), typeof(Jellyfin.Database.Implementations.Entities.User) })
            foreach (var member in type.GetMethods())
                if (JellyfinUserActions.Mutates(type.FullName!, member.Name)) names.Add(member.Name);
        return names;
    }

    // Writes a temporary file (or removes one): nobody reads it as a settings or secrets file. For a move or copy, its
    // destination decides.
    private static bool Temporary(InvocationExpressionSyntax call, IMethodSymbol method)
    {
        var args = call.ArgumentList.Arguments;
        var target = method.Name is "Move" or "Copy" or "Replace" ? (args.Count > 1 ? args[1] : null) : args.FirstOrDefault();
        return target != null && Temporary(target.Expression);
    }

    private static bool ReviewedWriter(SyntaxNode node, SemanticModel model)
        => node.Ancestors().OfType<MethodDeclarationSyntax>().FirstOrDefault() is { } method && model.GetDeclaredSymbol(method) is { } symbol && NotPeoplesSettingsWriters.ContainsKey(Name(symbol));

    private static bool Temporary(ExpressionSyntax target)
        => target is IdentifierNameSyntax { Identifier.ValueText: var id } && (id.Contains("temp", StringComparison.OrdinalIgnoreCase) || id.Contains("tmp", StringComparison.OrdinalIgnoreCase));

    // The path a file change changes (a move's, copy's or replace's destination; a FileInfo's own path for its delete,
    // create or open), or null when the call isn't one.
    private static ExpressionSyntax? FileChange(InvocationExpressionSyntax call, IMethodSymbol method, SemanticModel model)
    {
        if (method.ContainingNamespace?.ToDisplayString() != "System.IO") return null;
        var args = call.ArgumentList.Arguments;
        switch (method.ContainingType?.Name)
        {
            case "File" or "Directory" when FileChanges.Contains(method.Name) || AsyncFileChanges.Contains(method.Name) || (method.Name == "Open" && method.ContainingType.Name == "File"):
                if (method.Name == "Open" && !Writes(args.Skip(1), model)) return null;
                return method.Name is "Move" or "Copy" or "Replace" && args.Count > 1 ? args[1].Expression : args.FirstOrDefault()?.Expression;
            case "FileInfo" or "DirectoryInfo" or "FileSystemInfo" when InfoChanges.Contains(method.Name):
                if (method.Name == "Open" && !Writes(args, model)) return null;
                return method.Name is "MoveTo" or "CopyTo" or "Replace" ? args.FirstOrDefault()?.Expression : (call.Expression as MemberAccessExpressionSyntax)?.Expression;
            default:
                return null;
        }
    }

    // A FileStream that only reads: FileMode.Open with an explicit FileAccess.Read (without one it opens read-write), and no
    // other mode or access. Anything else, a StreamWriter or a mode or access the scan can't read as a constant, can write.
    private static bool ReadOnlyStream(BaseObjectCreationExpressionSyntax creation, SemanticModel model)
    {
        if (model.GetTypeInfo(creation).Type?.Name != "FileStream" || creation.ArgumentList is not { } list) return false;
        var fields = list.Arguments.Skip(1).Select(a => model.GetSymbolInfo(a.Expression).Symbol).OfType<IFieldSymbol>().ToList();
        var mode = fields.Where(f => f.ContainingType.Name == "FileMode").ToList();
        var access = fields.Where(f => f.ContainingType.Name == "FileAccess").ToList();
        return mode.Count == 1 && mode[0].Name == "Open" && access.Count == 1 && access[0].Name == "Read";
    }

    // A File.Open or FileInfo.Open that can write (any mode but Open, or any access but Read).
    private static bool Writes(IEnumerable<ArgumentSyntax> args, SemanticModel model)
        => args.Select(a => model.GetSymbolInfo(a.Expression).Symbol).OfType<IFieldSymbol>().Any(f => f.ContainingType.Name is "FileMode" && f.Name != "Open" || f.ContainingType.Name is "FileAccess" && f.Name != "Read")
           || !args.Any();

    private static string? Enclosing(SyntaxNode node) => node.Ancestors().OfType<MethodDeclarationSyntax>().FirstOrDefault()?.Identifier.ValueText;

    private static string Relative(SyntaxTree tree)
    {
        var marker = "Jellyfin.Plugin.JellyfinEnhanced" + Path.DirectorySeparatorChar;
        var at = tree.FilePath.LastIndexOf(marker, StringComparison.Ordinal);
        return (at < 0 ? tree.FilePath : tree.FilePath[(at + marker.Length)..]).Replace(Path.DirectorySeparatorChar, '/');
    }

    private static string Where(SyntaxNode node) => Relative(node.SyntaxTree) + ":" + (node.GetLocation().GetLineSpan().StartLinePosition.Line + 1);

    private static string Line(SyntaxNode node) => node.SyntaxTree.GetText().Lines[node.GetLocation().GetLineSpan().StartLinePosition.Line].ToString().Trim();

    private static string Name(ISymbol symbol) => symbol.ContainingType?.Name + "." + symbol.Name;

    /// <summary>
    /// Round 10 (4a-security-r10-3): whether a path is built from the settings area. Its symbols are followed (through
    /// locals, helpers and <c>this.</c>, as <see cref="SemanticFlow"/> does) and then further: a parameter to the argument
    /// every caller passes (constructor initializers too), a field or property to everything assigned to it. A path built
    /// from a reviewed member naming a file that is nobody's settings (<see cref="NotPeoplesSettings"/>) stops there.
    /// </summary>
    private sealed class Area(WriteGateWalk walk)
    {
        private const int MaxDepth = 16;
        private readonly SemanticFlow _flow = new(walk);
        private readonly Dictionary<ISymbol, bool> _known = new(SymbolEqualityComparer.Default);

        private static bool Reviewed(ISymbol symbol) => NotPeoplesSettings.ContainsKey(Name(symbol));

        public bool Settings(ExpressionSyntax path, SemanticModel model) => In(path, model, new HashSet<ISymbol>(SymbolEqualityComparer.Default), 0);

        private bool In(ExpressionSyntax expression, SemanticModel model, HashSet<ISymbol> seen, int depth)
        {
            var roots = _flow.Roots(expression, model, Reviewed);
            return !roots.Any(Reviewed) && roots.Any(root => In(root, seen, depth + 1));
        }

        private bool In(ISymbol symbol, HashSet<ISymbol> seen, int depth)
        {
            if (SettingsArea.Contains(Name(symbol)) || symbol is IPropertySymbol property && property.ExplicitInterfaceImplementations.Concat(Overridden(property)).Any(p => SettingsArea.Contains(Name(p)))) return true;
            if (_known.TryGetValue(symbol, out var known)) return known;
            if (depth > MaxDepth || !seen.Add(symbol)) return false;
            var found = false;
            foreach (var (value, model) in Values(symbol))
                if (In(value, model, seen, depth))
                {
                    found = true;
                    break;
                }

            if (seen.Count == 1) _known[symbol] = found;
            return found;
        }

        private static IEnumerable<IPropertySymbol> Overridden(IPropertySymbol property)
        {
            for (var p = property.OverriddenProperty; p != null; p = p.OverriddenProperty) yield return p;
            foreach (var type in property.ContainingType.AllInterfaces)
                foreach (var member in type.GetMembers(property.Name).OfType<IPropertySymbol>())
                    if (SymbolEqualityComparer.Default.Equals(property.ContainingType.FindImplementationForInterfaceMember(member), property)) yield return member;
        }

        // What a symbol can hold, in the plugin: a parameter's arguments at every call (constructor calls and initializers
        // included), a field's or property's initializer and every assignment.
        private IEnumerable<(ExpressionSyntax Value, SemanticModel Model)> Values(ISymbol symbol)
        {
            switch (symbol)
            {
                case IParameterSymbol { ContainingSymbol: IMethodSymbol method } parameter:
                    foreach (var (args, model) in Calls(method))
                    {
                        var argument = args.FirstOrDefault(a => a.NameColon?.Name.Identifier.ValueText == parameter.Name) ?? (parameter.Ordinal < args.Count && args[parameter.Ordinal].NameColon == null ? args[parameter.Ordinal] : null);
                        if (argument != null) yield return (argument.Expression, model);
                    }
                    break;
                case IFieldSymbol or IPropertySymbol:
                    foreach (var reference in symbol.DeclaringSyntaxReferences)
                    {
                        var syntax = reference.GetSyntax();
                        var initializer = syntax switch
                        {
                            VariableDeclaratorSyntax { Initializer.Value: var v } => v,
                            PropertyDeclarationSyntax { Initializer.Value: var v } => v,
                            _ => null,
                        };
                        if (initializer != null) yield return (initializer, walk.ModelOf(syntax.SyntaxTree));
                    }
                    foreach (var (use, model) in walk.References(symbol))
                        if (use.Parent is AssignmentExpressionSyntax assignment && assignment.Left == use) yield return (assignment.Right, model);
                    break;
            }
        }

        // Every call of a plugin method or constructor, as its argument list.
        private IEnumerable<(SeparatedSyntaxList<ArgumentSyntax> Args, SemanticModel Model)> Calls(IMethodSymbol method)
        {
            var target = method.OriginalDefinition;
            if (method.MethodKind != MethodKind.Constructor)
            {
                foreach (var (use, model) in walk.References(method))
                    if (use is InvocationExpressionSyntax call) yield return (call.ArgumentList.Arguments, model);
                yield break;
            }

            foreach (var (tree, model) in walk.Sources())
                foreach (var node in tree.GetRoot().DescendantNodes())
                {
                    var args = node switch
                    {
                        ObjectCreationExpressionSyntax { Type: var type } creation when type.ToString().EndsWith(target.ContainingType.Name, StringComparison.Ordinal) => creation.ArgumentList,
                        ImplicitObjectCreationExpressionSyntax implicitCreation => implicitCreation.ArgumentList,
                        ConstructorInitializerSyntax initializer when initializer.Ancestors().OfType<TypeDeclarationSyntax>().FirstOrDefault()?.Identifier.ValueText == target.ContainingType.Name => initializer.ArgumentList,
                        _ => null,
                    };
                    if (args != null && model.GetSymbolInfo(node).Symbol is IMethodSymbol called && SymbolEqualityComparer.Default.Equals(called.OriginalDefinition, target))
                        yield return (args.Arguments, model);
                }
        }
    }

    // Whether code runs inside its bracket.
    private sealed class Scan(WriteGateWalk walk)
    {
        private readonly SemanticFlow _flow = new(walk);

        // Null: the writer is inside the bracket it needs.
        public string? Problem(Writer writer) => Problem(writer.Node, writer.Model, writer, writer.Target is { } target ? new[] { (target, writer.Model) } : Array.Empty<(ExpressionSyntax, SemanticModel)>(), new HashSet<ISymbol>(SymbolEqualityComparer.Default));

        // Walks out from the code at node to the bracket around it. targets: the write's key expressions, as the code
        // at this level sees them (a helper's parameter is replaced by what each caller passes).
        private string? Problem(SyntaxNode node, SemanticModel model, Writer writer, IReadOnlyList<(ExpressionSyntax Expression, SemanticModel Model)> targets, HashSet<ISymbol> methods)
        {
            for (var n = node.Parent; n != null; n = n.Parent)
            {
                // A lambda handed to a bracket.
                if (n is AnonymousFunctionExpressionSyntax && n.Parent is ArgumentSyntax { Parent: ArgumentListSyntax { Parent: InvocationExpressionSyntax call } } && BracketOf(call, model) is { } bracket)
                    return Judge(bracket, writer, targets);
                // A method or local function: handed to a bracket, or every call of it inside one.
                if (n is MethodDeclarationSyntax or LocalFunctionStatementSyntax && model.GetDeclaredSymbol(n) is IMethodSymbol method)
                    return Method(method, writer, targets, methods);
            }

            return "outside any bracket (needs " + writer.Source + ")";
        }

        private string? Method(IMethodSymbol method, Writer writer, IReadOnlyList<(ExpressionSyntax Expression, SemanticModel Model)> targets, HashSet<ISymbol> methods)
        {
            if (!methods.Add(method.OriginalDefinition)) return "outside any bracket (a cycle)";
            var uses = walk.References(method).ToList();
            if (uses.Count == 0) return "outside any bracket (needs " + writer.Source + "; the method is never called)";
            foreach (var (use, useModel) in uses)
            {
                string? problem;
                if (use.Parent is ArgumentSyntax { Parent: ArgumentListSyntax { Parent: InvocationExpressionSyntax call } } && BracketOf(call, useModel) is { } bracket)
                    // A method group handed to a bracket: its parameters aren't the write's key.
                    problem = Judge(bracket, writer, targets.Where(t => !Mentions(t, method)).ToList());
                else
                    problem = Problem(use, useModel, writer, Rebind(targets, method, use, useModel), new HashSet<ISymbol>(methods, SymbolEqualityComparer.Default));
                if (problem != null) return problem + " (called at " + Where(use) + ")";
            }

            return null;
        }

        // The write's key expressions as the caller of method sees them: a key that is the method's parameter becomes the
        // argument passed at use.
        private static List<(ExpressionSyntax, SemanticModel)> Rebind(IReadOnlyList<(ExpressionSyntax Expression, SemanticModel Model)> targets, IMethodSymbol method, SyntaxNode use, SemanticModel useModel)
        {
            var result = new List<(ExpressionSyntax, SemanticModel)>();
            var args = use is InvocationExpressionSyntax call ? call.ArgumentList.Arguments : default;
            foreach (var (expression, model) in targets)
            {
                if (model.GetSymbolInfo(expression).Symbol is IParameterSymbol parameter && SymbolEqualityComparer.Default.Equals(parameter.ContainingSymbol.OriginalDefinition, method.OriginalDefinition)
                    && parameter.Ordinal < args.Count)
                    result.Add((args[parameter.Ordinal].Expression, useModel));
                else
                    result.Add((expression, model));
            }

            return result;
        }

        private static bool Mentions((ExpressionSyntax Expression, SemanticModel Model) target, IMethodSymbol method)
            => target.Model.GetSymbolInfo(target.Expression).Symbol is IParameterSymbol p && SymbolEqualityComparer.Default.Equals(p.ContainingSymbol.OriginalDefinition, method.OriginalDefinition);

        // What a bracket call is: its version source and key. Null: not a bracket.
        private Bracket? BracketOf(InvocationExpressionSyntax call, SemanticModel model)
        {
            if (model.GetSymbolInfo(call).Symbol is not IMethodSymbol m || !Brackets.Contains(Name(m))) return null;
            var args = call.ArgumentList.Arguments;
            switch (Name(m))
            {
                case "AcquireDatabase.WriteAutomation":
                    return new("automation", Array.Empty<(ExpressionSyntax, SemanticModel, object?)>(), "WriteAutomation");
                case "JellyfinUserVersions.Mutate":
                    return new("jellyfin_user", new[] { (args[0].Expression, model, (object?)null) }, "JellyfinUserVersions.Mutate(" + args[0] + ")");
                case "JellyfinUserVersions.MutateAll":
                    return new("jellyfin_user", Array.Empty<(ExpressionSyntax, SemanticModel, object?)>(), "JellyfinUserVersions.MutateAll");
            }

            // FactVersion.Mutate: the source its receiver comes from, through aliases and helpers.
            ExpressionSyntax? receiver = call.Expression switch
            {
                MemberAccessExpressionSyntax access => access.Expression,
                MemberBindingExpressionSyntax => call.Ancestors().OfType<ConditionalAccessExpressionSyntax>().FirstOrDefault()?.Expression,
                _ => null,
            };
            if (receiver == null) return new(null, Array.Empty<(ExpressionSyntax, SemanticModel, object?)>(), "a FactVersion of unknown origin");
            var origins = _flow.Origins(receiver, model, s => Accessors.ContainsKey(Name(s)));
            string? source = null;
            var keys = new List<(ExpressionSyntax, SemanticModel, object?)>();
            foreach (var origin in origins)
            {
                var found = origin.Symbol != null && Accessors.TryGetValue(Name(origin.Symbol), out var s) ? s : null;
                // The settings versions' dictionary only; a store's Version only its own (this) one.
                if (found != null && origin.Symbol!.Name == "For" && !(origin.Node is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Expression: var owner } } && origin.Model.GetSymbolInfo(owner).Symbol is IFieldSymbol { Name: "_settingsVersions", ContainingType.Name: "UserConfigurationManager" }))
                    found = null;
                if (found == "secrets" && origin.Node is MemberAccessExpressionSyntax { Expression: not ThisExpressionSyntax })
                    found = null;
                if (found == null || (source != null && source != found))
                    return new(null, Array.Empty<(ExpressionSyntax, SemanticModel, object?)>(), "a FactVersion from " + origin);
                source = found;
                if (origin.Node is InvocationExpressionSyntax keyed) keys.AddRange(keyed.ArgumentList.Arguments.Select(a => (a.Expression, origin.Model, origin.Frame)));
            }

            return new(source, keys, "FactVersion from " + string.Join(", ", origins));
        }

        // The bracket is the source the writer needs, keyed by the writer's own person (each key argument built from
        // symbols the write's target is built from too).
        private string? Judge(Bracket bracket, Writer writer, IReadOnlyList<(ExpressionSyntax Expression, SemanticModel Model)> targets)
        {
            if (bracket.Source != writer.Source)
                return "inside the wrong bracket (" + bracket.Description + "; needs " + writer.Source + ")";
            if (bracket.Keys.Count == 0) return null;
            if (targets.Count == 0) return "inside a person's bracket (" + bracket.Description + ") but the write has no person to match";
            var target = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
            foreach (var (expression, model) in targets) target.UnionWith(_flow.Roots(expression, model));
            foreach (var (key, model, frame) in bracket.Keys)
            {
                var roots = _flow.RootsAt(key, model, frame);
                if (roots.Count == 0 || !roots.IsSubsetOf(target))
                    return "inside another key's bracket (" + bracket.Description + ": " + key + " isn't what the write changes: " + string.Join(", ", targets.Select(t => t.Expression)) + ")";
            }

            return null;
        }
    }

    [Fact]
    public void EveryWriterOfAVersionedSourceIsInsideItsBracket()
    {
        var problems = Unbracketed(WriteGateWalk.Plugin);
        if (problems.Count > 0) throw new Xunit.Sdk.XunitException(string.Join("\n", problems));
        // The scan sees the writers it is about.
        var writers = Writers(WriteGateWalk.Plugin).ToList();
        Assert.Contains(writers, w => w.Source == "automation");
        Assert.Contains(writers, w => w.Source == "person_settings" && w.Target != null);
        Assert.Contains(writers, w => w.Source == "jellyfin_user");
        Assert.Contains(writers, w => w.Source == "secrets");
        // Round 10: the settings writers are found in every source file, and the reviewed non-settings files still exist
        // (a renamed one would otherwise drop out of the review unnoticed).
        Assert.Contains(writers, w => w.Source == "person_settings" && Relative(w.Node.SyntaxTree) == Backup);
        var declared = WriteGateWalk.Plugin.Sources().SelectMany(t => t.Tree.GetRoot().DescendantNodes().OfType<TypeDeclarationSyntax>())
            .SelectMany(type => type.Members.SelectMany(m => m switch
            {
                FieldDeclarationSyntax f => f.Declaration.Variables.Select(v => v.Identifier.ValueText),
                PropertyDeclarationSyntax p => new[] { p.Identifier.ValueText },
                MethodDeclarationSyntax d => new[] { d.Identifier.ValueText },
                _ => Array.Empty<string>(),
            }).Select(n => type.Identifier.ValueText + "." + n)).ToHashSet(StringComparer.Ordinal);
        // (A type this target compiles out, such as a Jellyfin 12-only service on 10.11, has nothing to check.)
        var types = declared.Select(n => n[..n.IndexOf('.')]).ToHashSet(StringComparer.Ordinal);
        Assert.All(NotPeoplesSettings.Keys.Concat(NotPeoplesSettingsWriters.Keys).Where(n => types.Contains(n[..n.IndexOf('.')])), name => Assert.True(declared.Contains(name), name + " is reviewed but not in the plugin"));
        Assert.Contains(NotPeoplesSettings.Keys, n => types.Contains(n[..n.IndexOf('.')]));
    }

    // Each case writes a versioned source outside its bracket, or inside the wrong one (the copy must still compile),
    // and the scan reports it.
    private static readonly Dictionary<string, (string File, string Text, string Planted, string Reported)> Plants = new(StringComparer.Ordinal)
    {
        ["breaker_write_outside"] = ("Services/Acquire/Automation/AutomationStore.cs",
            "public void SetMeta(string key, string value) =>",
            "public void Planted(string t) => _db.Write((c, x) => RequestLedger.Exec(c, x, \"UPDATE automation_breakers SET failures=0 WHERE target=$t\", (\"$t\", t)));\n        public void SetMeta(string key, string value) =>",
            "a write of the automation tables: outside any bracket"),
        ["grant_delete_outside"] = ("Services/Acquire/Automation/AutomationStore.cs",
            "public void SetMeta(string key, string value) =>",
            "public void Planted(Guid u) => Planted(_db, u);\n        private static int Planted(AcquireDatabase db, Guid u) => db.Write((c, x) => RequestLedger.Exec(c, x, \"DELETE FROM automation_grants WHERE user_id=$u\", (\"$u\", RequestLedger.Id(u))));\n        public void SetMeta(string key, string value) =>",
            "a write of the automation tables: outside any bracket"),
        ["settings_file_outside"] = (Users,
            "public object UserSettingsLock(string userId) =>",
            "public void Planted(string path) => File.WriteAllText(path, \"{}\");\n        public object UserSettingsLock(string userId) =>",
            "a settings file change: outside any bracket"),
        ["permission_change_outside"] = ("Services/MaintenanceModeService.cs",
            "private readonly Logger _logger;",
            "internal System.Threading.Tasks.Task Planted(Jellyfin.Database.Implementations.Entities.User u, MediaBrowser.Model.Users.UserPolicy p) => _userManager.UpdatePolicyAsync(u.Id, p);\n        private readonly Logger _logger;",
            "a Jellyfin user change (IUserManager.UpdatePolicyAsync): outside any bracket"),
        ["secrets_replaced_outside"] = (Secrets,
            "public string FilePath => _path;",
            "public string FilePath => _path;\n        internal void Planted() { lock (_lock) { _values = new Dictionary<string, string>(StringComparer.Ordinal); } }",
            "the stored secrets replaced: outside any bracket"),
        // Round 9 (4a-security-r9-2): the settings file moved into place inside a version the check never samples.
        ["wrong_version_source"] = (Users,
            "VersionOf(userId, fileName).Mutate(() =>",
            "_otherFiles.Mutate(() =>",
            "a settings file change: inside the wrong bracket"),
        // The same through a local alias, and through a helper that returns it.
        ["wrong_source_through_an_alias"] = (Users,
            "VersionOf(userId, fileName).Mutate(() =>",
            "var version = _otherFiles; version.Mutate(() =>",
            "a settings file change: inside the wrong bracket"),
        ["wrong_source_through_a_helper"] = (Users,
            "VersionOf(userId, fileName).Mutate(() =>",
            "Pick(userId).Mutate(() =>",
            "a settings file change: inside the wrong bracket"),
        // Another person's settings version around this person's file.
        ["another_persons_settings_version"] = (Users,
            "VersionOf(userId, fileName).Mutate(() =>",
            "VersionOf(SettingsFileName, fileName).Mutate(() =>",
            "a settings file change: inside another key's bracket"),
        // An unrelated FactVersion around an automation-table write (it moves no version the check samples).
        ["unrelated_version_around_an_automation_write"] = ("Services/Acquire/Automation/AutomationStore.cs",
            "_db.WriteAutomation((c, t) => RequestLedger.Exec(c, t, \"UPDATE automation_breakers SET failures=0,opened_until=NULL,updated_at=$at WHERE target=$t AND (failures>0 OR opened_until IS NOT NULL)\",\n                    (\"$t\", target), (\"$at\", RequestLedger.Ms(now))));",
            "new Jellyfin.Plugin.JellyfinEnhanced.Helpers.FactVersion().Mutate(() => _db.Write((c, t) => RequestLedger.Exec(c, t, \"UPDATE automation_breakers SET failures=0,opened_until=NULL,updated_at=$at WHERE target=$t AND (failures>0 OR opened_until IS NOT NULL)\",\n                    (\"$t\", target), (\"$at\", RequestLedger.Ms(now)))));",
            "a write of the automation tables: inside the wrong bracket"),
        // The settings version around a secrets change.
        ["settings_version_around_secrets"] = (Secrets,
            "public string FilePath => _path;",
            "public string FilePath => _path;\n        internal void Planted() { Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserConfigurationManager.AllSettingsVersion.Mutate(() => { _values = new Dictionary<string, string>(StringComparer.Ordinal); }); }",
            "the stored secrets replaced: inside the wrong bracket"),
        // Another user's Jellyfin version around this user's policy change.
        ["another_users_jellyfin_version"] = ("Services/MaintenanceModeService.cs",
            "await JellyfinUserVersions.Mutate(user.Id, () => _userManager.UpdatePolicyAsync(user.Id, dto.Policy)).ConfigureAwait(false);",
            "await JellyfinUserVersions.Mutate(Guid.Empty, () => _userManager.UpdatePolicyAsync(user.Id, dto.Policy)).ConfigureAwait(false);",
            "a Jellyfin user change (IUserManager.UpdatePolicyAsync): inside another key's bracket"),
        // Round 10 (4a-security-r10-3): a settings file written from another source file. Round 9 looked for settings-file
        // changes in UserConfigurationManager.cs and JeBackupService.cs only. Here another service writes a person's
        // settings.json directly, by a path it builds from the plugin's own configuration folder,
        ["settings_written_by_another_service"] = ("Services/WhatsNewService.cs",
            "private string SnapshotFilePath =>",
            "internal void Planted(string userId) => File.WriteAllText(Path.Combine(_configBaseDir, userId, \"settings.json\"), \"{}\");\n        private string SnapshotFilePath =>",
            "a settings file change: outside any bracket"),
        // and the same through a FileStream.
        ["settings_stream_by_another_service"] = ("Services/WhatsNewService.cs",
            "private string SnapshotFilePath =>",
            "internal void Planted(string userId) { using var stream = new FileStream(Path.Combine(_configBaseDir, userId, \"settings.json\"), FileMode.Create); stream.WriteByte(1); }\n        private string SnapshotFilePath =>",
            "a settings file change: outside any bracket"),
        // Integration (the read-only stream exemption): a FileStream opened with FileMode.Open but no FileAccess opens
        // read-write, so it is still a writer.
        ["settings_stream_open_mode_without_access"] = ("Services/WhatsNewService.cs",
            "private string SnapshotFilePath =>",
            "internal void Planted(string userId) { using var stream = new FileStream(Path.Combine(_configBaseDir, userId, \"settings.json\"), FileMode.Open); stream.WriteByte(1); }\n        private string SnapshotFilePath =>",
            "a settings file change: outside any bracket"),
        // and so is one opened for reading and writing.
        ["settings_stream_open_read_write"] = (Users,
            "public object UserSettingsLock(string userId) =>",
            "public void Planted(string path) { using var stream = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.Read); stream.WriteByte(1); }\n        public object UserSettingsLock(string userId) =>",
            "a settings file change: outside any bracket"),
    };

    // Round 10 (4a-security-r10-3, the reviewer's mutation): the bracketed File.Move replaced by a call to a helper in
    // another source file, outside the bracket. The helper's destination is its parameter: the scan follows it to the
    // argument every caller passes (the person's settings path) and finds the write unbracketed.
    private const string Publisher = "\nnamespace Jellyfin.Plugin.JellyfinEnhanced.Configuration { internal static class SettingsPublisher { public static void Publish(string source, string destination) => System.IO.File.Move(source, destination, true); } }";
    private const string BracketedMove = "VersionOf(userId, fileName).Mutate(() =>\n                {\n                    File.Move(tempPath, configPath, overwrite: true);\n                    Moved?.Invoke(Normalized(userId), fileName);\n                });";

    private static WriteGateWalk Published(string replacement) => WriteGateWalk.Plugin
        .With(Users, source =>
        {
            Assert.Equal(1, source.Split(BracketedMove).Length - 1);
            return source.Replace(BracketedMove, replacement, StringComparison.Ordinal);
        })
        .With("Helpers/FactVersion.cs", source => source + Publisher);

    [Fact]
    public void ASettingsFilePublishedFromAnotherSourceFileOutsideTheBracketIsReported()
    {
        var walk = Published("SettingsPublisher.Publish(tempPath, configPath);\n                Moved?.Invoke(Normalized(userId), fileName);");
        var errors = walk.Errors(Users);
        if (errors.Count > 0) throw new Xunit.Sdk.XunitException(string.Join("\n", errors));
        var problems = Unbracketed(walk);
        Assert.Contains(problems, p => p.StartsWith("Helpers/FactVersion.cs:", StringComparison.Ordinal) && p.Contains("a settings file change: outside any bracket", StringComparison.Ordinal));
    }

    // The same helper called inside the person's bracket passes: the scan follows the helper, it doesn't reject it.
    [Fact]
    public void ASettingsFilePublishedFromAnotherSourceFileInsideTheBracketPasses()
    {
        var walk = Published("VersionOf(userId, fileName).Mutate(() =>\n                {\n                    SettingsPublisher.Publish(tempPath, configPath);\n                    Moved?.Invoke(Normalized(userId), fileName);\n                });");
        var errors = walk.Errors(Users);
        if (errors.Count > 0) throw new Xunit.Sdk.XunitException(string.Join("\n", errors));
        Assert.Empty(Unbracketed(walk));
    }

    // Helpers a plant uses, added to the file too.
    private static readonly Dictionary<string, (string Text, string Added)> Helpers = new(StringComparer.Ordinal)
    {
        ["wrong_source_through_a_helper"] = ("public object UserSettingsLock(string userId) =>", "private static FactVersion Pick(string userId) => string.IsNullOrEmpty(userId) ? _allSettingsVersion : _otherFiles;\n        public object UserSettingsLock(string userId) =>"),
        ["right_source_through_a_helper"] = ("public object UserSettingsLock(string userId) =>", "private static FactVersion SettingsOf(string person, string file) => VersionOf(person, file);\n        public object UserSettingsLock(string userId) =>"),
    };

    // And these must still pass: the right source through an alias and a helper (the scan follows them, it doesn't
    // reject every indirection).
    private static readonly Dictionary<string, (string File, string Text, string Planted)> Accepted = new(StringComparer.Ordinal)
    {
        ["right_source_through_an_alias"] = (Users, "VersionOf(userId, fileName).Mutate(() =>", "var version = VersionOf(userId, fileName); version.Mutate(() =>"),
        ["right_source_through_a_helper"] = (Users, "VersionOf(userId, fileName).Mutate(() =>", "SettingsOf(userId, fileName).Mutate(() =>"),
        ["right_source_through_this"] = (Secrets, "var values = Version.Mutate(() => _values = Load());", "var values = this.Version.Mutate(() => _values = Load());"),
    };

    public static IEnumerable<object[]> PlantCases() => Plants.Keys.Select(k => new object[] { k });

    public static IEnumerable<object[]> AcceptedCases() => Accepted.Keys.Select(k => new object[] { k });

    private static WriteGateWalk Planted(string name, string file, string text, string planted) => WriteGateWalk.Plugin.With(file, source =>
    {
        var at = source.IndexOf(text, StringComparison.Ordinal);
        Assert.True(at >= 0 && source.IndexOf(text, at + 1, StringComparison.Ordinal) < 0, name + ": \"" + text + "\" must be there once");
        source = source[..at] + planted + source[(at + text.Length)..];
        if (Helpers.TryGetValue(name, out var helper))
        {
            var where = source.IndexOf(helper.Text, StringComparison.Ordinal);
            Assert.True(where >= 0, name + ": \"" + helper.Text + "\" must be there");
            source = source[..where] + helper.Added + source[(where + helper.Text.Length)..];
        }
        return source;
    });

    [Theory]
    [MemberData(nameof(PlantCases))]
    public void TheScanReportsAWriterPlantedOutsideItsBracket(string plant)
    {
        var (file, text, planted, reported) = Plants[plant];
        var walk = Planted(plant, file, text, planted);
        var errors = walk.Errors(file);
        if (errors.Count > 0) throw new Xunit.Sdk.XunitException(string.Join("\n", errors));
        var problems = Unbracketed(walk);
        Assert.True(problems.Any(p => p.Contains(reported, StringComparison.Ordinal)), plant + ": expected \"" + reported + "\" in:\n" + string.Join("\n", problems));
    }

    [Theory]
    [MemberData(nameof(AcceptedCases))]
    public void TheScanFollowsTheRightSourceThroughAliasesAndHelpers(string plant)
    {
        var (file, text, planted) = Accepted[plant];
        var walk = Planted(plant, file, text, planted);
        var errors = walk.Errors(file);
        if (errors.Count > 0) throw new Xunit.Sdk.XunitException(string.Join("\n", errors));
        Assert.Empty(Unbracketed(walk));
    }
}
