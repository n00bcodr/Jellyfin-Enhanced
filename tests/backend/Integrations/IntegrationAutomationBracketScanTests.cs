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
                // People's settings files: the path changed (a move's or copy's destination) is the key.
                if (file is Users or Backup && space == "System.IO" && method.ContainingType!.Name is "File" or "Directory" && FileChanges.Contains(method.Name)
                    && !Temporary(call, method) && !(file == Users && SharedFiles.ContainsKey(Enclosing(call) ?? string.Empty))
                    && !(file == Backup && Enclosing(call) != "Restore"))
                    yield return new Writer(call, model, "a settings file change", "person_settings", method.Name is "Move" or "Copy" or "Replace" && args.Count > 1 ? args[1].Expression : args.FirstOrDefault()?.Expression);
                // A Jellyfin user change or sign-in: the user (its id, or the user itself) is the key.
                if (method.ContainingType is { } type && JellyfinUserActions.Mutates(Metadata(type), method.MetadataName))
                    yield return new Writer(call, model, "a Jellyfin user change (" + type.Name + "." + method.Name + ")", "jellyfin_user", args.FirstOrDefault()?.Expression);
                // The secrets file.
                if (file == Secrets && space == "System.IO" && method.ContainingType!.Name == "File" && FileChanges.Contains(method.Name) && !Temporary(call, method))
                    yield return new Writer(call, model, "a secrets file change", "secrets", null);
            }
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
        return name == "BackupDatabase" || UserChanges.Contains(name) || (file is Users or Backup or Secrets && FileChanges.Contains(name));
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
        return target?.Expression is IdentifierNameSyntax { Identifier.ValueText: var id } && (id.Contains("temp", StringComparison.OrdinalIgnoreCase) || id.Contains("tmp", StringComparison.OrdinalIgnoreCase));
    }

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
    };

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
