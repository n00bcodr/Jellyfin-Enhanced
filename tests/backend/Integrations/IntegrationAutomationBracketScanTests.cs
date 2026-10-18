using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace JE.Tests;

/// <summary>
/// 4a review round 8 (4a-security-r8-3): every change to a source a versioned fact of the automatic-write check depends on
/// is made inside a version bracket (FactVersion.Mutate, AcquireDatabase.WriteAutomation, JellyfinUserVersions.Mutate):
/// odd before the change can be seen, even after. Before round 8 the versions moved only after the change (budgets,
/// breakers and grants after their commit, settings.json after its file was in place). The scan compiles the plugin's
/// source and finds every writer by what it writes, not by where it is:
/// <list type="bullet">
/// <item><description>every SQL statement that inserts, updates or deletes rows of automation_budget, automation_breakers or
/// automation_grants, and a restore's copy into the live database;</description></item>
/// <item><description>every file change where people's settings files are written (UserConfigurationManager, the JE backup
/// restore), except temporary files and the shared files listed with their reason;</description></item>
/// <item><description>every change JE makes to a person's Jellyfin permissions (IUserManager policy, update, delete);</description></item>
/// <item><description>every change of the secrets store's values (Seerr's API key).</description></item>
/// </list>
/// A writer is inside a bracket when it is in a lambda (or a method group) handed to one, or in a method every call of
/// which is.
/// </summary>
public class IntegrationAutomationBracketScanTests
{
    private const string Users = "Configuration/UserConfigurationManager.cs";
    private const string Backup = "Services/Backup/JeBackupService.cs";
    private const string Secrets = "Services/Secrets/SecretsStore.cs";
    private const string Database = "Services/Acquire/AcquireDatabase.cs";

    // The brackets ("Type.Member").
    private static readonly HashSet<string> Brackets = new(StringComparer.Ordinal)
    {
        "FactVersion.Mutate", "FactVersion.MutateAsync", "AcquireDatabase.WriteAutomation", "JellyfinUserVersions.Mutate",
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

    /// <summary>Every writer of a versioned source that isn't inside a bracket ("file:line: what").</summary>
    internal static List<string> Unbracketed(WriteGateWalk walk)
    {
        var scan = new Scan(walk);
        var problems = new List<string>();
        foreach (var (tree, model) in walk.Sources())
        {
            var file = Relative(tree);
            var root = tree.GetRoot();
            // The automation tables.
            foreach (var token in root.DescendantTokens().Where(t => t.IsKind(SyntaxKind.StringLiteralToken) || t.IsKind(SyntaxKind.InterpolatedStringTextToken)))
                if (AutomationWrite.IsMatch(token.ValueText) && !scan.Bracketed(token.Parent!, model))
                    problems.Add(Where(token.Parent!) + ": a write of the automation tables outside WriteAutomation: " + Line(token.Parent!));
            foreach (var call in root.DescendantNodes().OfType<InvocationExpressionSyntax>().Where(c => Candidate(c, file)))
            {
                if (model.GetSymbolInfo(call).Symbol is not IMethodSymbol method) continue;
                var space = method.ContainingNamespace?.ToDisplayString();
                // A restore's copy into the live database.
                if (file == Database && method.Name == "BackupDatabase" && Enclosing(call) == "ReplaceWith" && !scan.Bracketed(call, model))
                    problems.Add(Where(call) + ": the restore's copy outside the automation version's bracket");
                // People's settings files.
                if (file is Users or Backup && space == "System.IO" && method.ContainingType!.Name is "File" or "Directory" && FileChanges.Contains(method.Name)
                    && !Temporary(call, method) && !(file == Users && SharedFiles.ContainsKey(Enclosing(call) ?? string.Empty))
                    && !(file == Backup && Enclosing(call) != "Restore")
                    && !scan.Bracketed(call, model))
                    problems.Add(Where(call) + ": a file change outside the settings version's bracket: " + Line(call));
                // A person's Jellyfin permissions.
                if (method.ContainingType?.ToDisplayString() == "MediaBrowser.Controller.Library.IUserManager" && method.Name is "UpdatePolicyAsync" or "UpdateUserAsync" or "DeleteUserAsync"
                    && !scan.Bracketed(call, model))
                    problems.Add(Where(call) + ": a Jellyfin permission change outside JellyfinUserVersions.Mutate: " + Line(call));
                // The secrets file.
                if (file == Secrets && space == "System.IO" && method.ContainingType!.Name == "File" && FileChanges.Contains(method.Name) && !Temporary(call, method) && !scan.Bracketed(call, model))
                    problems.Add(Where(call) + ": a secrets file change outside the store's version bracket: " + Line(call));
            }
            // The secrets in memory.
            if (file == Secrets)
                foreach (var assign in root.DescendantNodes().OfType<AssignmentExpressionSyntax>().Where(a => a.Left.ToString() == "_values"))
                    if (!scan.Bracketed(assign, model))
                        problems.Add(Where(assign) + ": the stored secrets replaced outside the store's version bracket: " + Line(assign));
        }

        return problems;
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
        return name is "BackupDatabase" or "UpdatePolicyAsync" or "UpdateUserAsync" or "DeleteUserAsync" || (file is Users or Backup or Secrets && FileChanges.Contains(name));
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

    // Whether code runs inside a bracket.
    private sealed class Scan(WriteGateWalk walk)
    {
        private readonly Dictionary<ISymbol, bool> _methods = new(SymbolEqualityComparer.Default);

        public bool Bracketed(SyntaxNode node, SemanticModel model)
        {
            for (var n = node.Parent; n != null; n = n.Parent)
            {
                // A lambda handed to a bracket.
                if (n is AnonymousFunctionExpressionSyntax && n.Parent is ArgumentSyntax { Parent: ArgumentListSyntax { Parent: InvocationExpressionSyntax call } } && IsBracket(call, model))
                    return true;
                // A method or local function: bracketed when it is handed to a bracket, or every call of it is bracketed.
                if (n is MethodDeclarationSyntax or LocalFunctionStatementSyntax && model.GetDeclaredSymbol(n) is { } method)
                    return Method(method);
            }

            return false;
        }

        private static bool IsBracket(InvocationExpressionSyntax call, SemanticModel model)
            => model.GetSymbolInfo(call).Symbol is IMethodSymbol m && Brackets.Contains(m.ContainingType?.Name + "." + m.Name);

        private bool Method(ISymbol method)
        {
            method = method.OriginalDefinition;
            if (_methods.TryGetValue(method, out var known)) return known;
            _methods[method] = false; // a cycle isn't bracketed by itself
            var uses = References(method).ToList();
            var bracketed = uses.Count > 0 && uses.All(u => u.Use.Parent is ArgumentSyntax { Parent: ArgumentListSyntax { Parent: InvocationExpressionSyntax call } } && IsBracket(call, u.Model)
                || Bracketed(u.Use, u.Model));
            _methods[method] = bracketed;
            return bracketed;
        }

        // Every place the method is named (a call or a method group), in the plugin.
        private IEnumerable<(SyntaxNode Use, SemanticModel Model)> References(ISymbol method)
        {
            foreach (var (tree, model) in walk.Sources())
                foreach (var name in tree.GetRoot().DescendantNodes().OfType<SimpleNameSyntax>().Where(n => n.Identifier.ValueText == method.Name))
                {
                    var info = model.GetSymbolInfo(name);
                    var symbol = info.Symbol ?? info.CandidateSymbols.FirstOrDefault();
                    if (symbol == null || !SymbolEqualityComparer.Default.Equals(symbol.OriginalDefinition, method)) continue;
                    // The whole expression the name is part of (a.B, a?.B).
                    SyntaxNode use = name;
                    while (use.Parent is MemberAccessExpressionSyntax or MemberBindingExpressionSyntax or ConditionalAccessExpressionSyntax && use.Parent is not InvocationExpressionSyntax) use = use.Parent;
                    if (use.Parent is InvocationExpressionSyntax invocation && invocation.Expression == use) use = invocation;
                    yield return (use, model);
                }
        }
    }

    [Fact]
    public void EveryWriterOfAVersionedSourceIsInsideItsBracket()
    {
        var problems = Unbracketed(WriteGateWalk.Plugin);
        if (problems.Count > 0) throw new Xunit.Sdk.XunitException(string.Join("\n", problems));
    }

    // Each case writes a versioned source outside its bracket (the copy must still compile), and the scan reports it.
    private static readonly Dictionary<string, (string File, string Text, string Planted, string Reported)> Plants = new(StringComparer.Ordinal)
    {
        ["breaker_write_outside"] = ("Services/Acquire/Automation/AutomationStore.cs",
            "public void SetMeta(string key, string value) =>",
            "public void Planted(string t) => _db.Write((c, x) => RequestLedger.Exec(c, x, \"UPDATE automation_breakers SET failures=0 WHERE target=$t\", (\"$t\", t)));\n        public void SetMeta(string key, string value) =>",
            "a write of the automation tables outside WriteAutomation"),
        ["grant_delete_outside"] = ("Services/Acquire/Automation/AutomationStore.cs",
            "public void SetMeta(string key, string value) =>",
            "public void Planted(Guid u) => Planted(_db, u);\n        private static int Planted(AcquireDatabase db, Guid u) => db.Write((c, x) => RequestLedger.Exec(c, x, \"DELETE FROM automation_grants WHERE user_id=$u\", (\"$u\", RequestLedger.Id(u))));\n        public void SetMeta(string key, string value) =>",
            "a write of the automation tables outside WriteAutomation"),
        ["settings_file_outside"] = (Users,
            "public object UserSettingsLock(string userId) =>",
            "public void Planted(string path) => File.WriteAllText(path, \"{}\");\n        public object UserSettingsLock(string userId) =>",
            "a file change outside the settings version's bracket"),
        ["permission_change_outside"] = ("Services/MaintenanceModeService.cs",
            "private readonly Logger _logger;",
            "internal System.Threading.Tasks.Task Planted(Jellyfin.Database.Implementations.Entities.User u, MediaBrowser.Model.Users.UserPolicy p) => _userManager.UpdatePolicyAsync(u.Id, p);\n        private readonly Logger _logger;",
            "a Jellyfin permission change outside JellyfinUserVersions.Mutate"),
        ["secrets_replaced_outside"] = (Secrets,
            "public string FilePath => _path;",
            "public string FilePath => _path;\n        internal void Planted() { lock (_lock) { _values = new Dictionary<string, string>(StringComparer.Ordinal); } }",
            "the stored secrets replaced outside the store's version bracket"),
    };

    public static IEnumerable<object[]> PlantCases() => Plants.Keys.Select(k => new object[] { k });

    [Theory]
    [MemberData(nameof(PlantCases))]
    public void TheScanReportsAWriterPlantedOutsideItsBracket(string plant)
    {
        var (file, text, planted, reported) = Plants[plant];
        var walk = WriteGateWalk.Plugin.With(file, source =>
        {
            var at = source.IndexOf(text, StringComparison.Ordinal);
            Assert.True(at >= 0 && source.IndexOf(text, at + 1, StringComparison.Ordinal) < 0, plant + ": \"" + text + "\" must be there once");
            return source[..at] + planted + source[(at + text.Length)..];
        });
        var errors = walk.Errors(file);
        if (errors.Count > 0) throw new Xunit.Sdk.XunitException(string.Join("\n", errors));
        Assert.Contains(Unbracketed(walk), p => p.Contains(reported, StringComparison.Ordinal));
    }
}
