using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace JE.Tests;

/// <summary>
/// 4f review round 1 (security-5), defence in depth (D41): a source walk over the plugin's production code. The runtime
/// guarantee is that every writer goes through <c>NotifyStore.UpdatePrefs</c>/<c>TryUpdatePrefs</c> (field-only, one
/// transaction; the race tests per writer check it). This walk catches a new writer that stores a whole settings document
/// read earlier: nothing but the store's own declaration names <c>SavePrefs</c>, and no SQL that writes
/// <c>notify_prefs</c> is outside the store's transactional update (and its purge).
/// </summary>
public class NotifyPrefsWriteWalkTests
{
    private static readonly System.Text.RegularExpressions.Regex WritesPrefs = new(
        @"\b(INSERT\s+(OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(\s+OR\s+\w+)?|DELETE\s+FROM)\s+notify_prefs\b",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase);

    private static IEnumerable<(string Path, SyntaxNode Root)> Production()
    {
        var root = Path.Combine(IntegrationAutoRequestLedgerTests.Root(), "Jellyfin.Plugin.JellyfinEnhanced");
        foreach (var file in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
        {
            if (file[root.Length..].Split(Path.DirectorySeparatorChar).Any(d => d is "obj" or "bin")) continue;
            yield return (file[(root.Length + 1)..], CSharpSyntaxTree.ParseText(File.ReadAllText(file)).GetRoot());
        }
    }

    [Fact]
    public void NoProductionCodeStoresAWholePreferencesDocument()
    {
        var found = new List<string>();
        foreach (var (path, root) in Production())
        {
            // Any mention: a call, a method group, nameof or a delegate. Only the declaration itself is allowed.
            foreach (var name in root.DescendantNodes().OfType<IdentifierNameSyntax>().Where(n => n.Identifier.ValueText == "SavePrefs"))
                found.Add(path + ":" + (name.GetLocation().GetLineSpan().StartLinePosition.Line + 1));
        }

        Assert.Empty(found);
        var declarations = Production().SelectMany(p => p.Root.DescendantNodes().OfType<MethodDeclarationSyntax>().Where(m => m.Identifier.ValueText == "SavePrefs").Select(m => p.Path)).ToList();
        Assert.Equal(new[] { Path.Combine("Services", "Acquire", "Notify", "NotifyStore.cs") }, declarations);
    }

    [Fact]
    public void OnlyTheStoresTransactionalUpdateWritesThePreferencesTable()
    {
        var writers = new List<string>();
        foreach (var (path, root) in Production())
        {
            foreach (var literal in root.DescendantNodes().OfType<LiteralExpressionSyntax>().Where(l => l.IsKind(SyntaxKind.StringLiteralExpression)))
            {
                var sql = literal.Token.ValueText;
                if (!WritesPrefs.IsMatch(sql)) continue;
                var method = literal.Ancestors().OfType<MethodDeclarationSyntax>().FirstOrDefault()?.Identifier.ValueText ?? "(none)";
                writers.Add(Path.GetFileName(path) + ":" + method);
            }
        }

        // The transactional update and the test-only document write (the purge deletes by a table list, not a literal).
        Assert.Equal(new[] { "NotifyStore.cs:SavePrefs", "NotifyStore.cs:TryUpdatePrefs" }, writers.Distinct().OrderBy(w => w, StringComparer.Ordinal));
    }
}
