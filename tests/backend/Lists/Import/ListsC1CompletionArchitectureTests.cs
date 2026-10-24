using System.Runtime.CompilerServices;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace JE.Tests;

public class ListsC1CompletionArchitectureTests
{
    private static string Root([CallerFilePath] string caller = "") => Path.GetFullPath(Path.Combine(
        Path.GetDirectoryName(caller)!, "../../../..", "Jellyfin.Plugin.JellyfinEnhanced"));

    // Explicit member-level inventory, not file-level exemptions: adding inference beside a display projection fails.
    // Retained display/status facts, first-missing placement and refresh scheduling cannot grant completion/scope.
    private static readonly HashSet<string> DisplayAndStorage = new(StringComparer.Ordinal)
    {
        "ListResolver.cs:ExpectedCount", "ListResolver.cs:AiredCount", "ListResolver.cs:HasUnexpectedFills", "ListResolver.cs:FirstMissing",
        "ListService.cs:StatusesAsync", "ListService.cs:BuildView", "ListService.cs:PatchAsync",
        "ListMetadata.cs:ApplyCurrent", "ListMetadata.cs:Signature",
        "ListStore.cs:Validate", "ExperimentalListImporter.cs:Parse", "ExperimentalListImporter.cs:ValidEntry",
        "ListRules.cs:TryNormalize", "ImportPlaceholders.cs:FromCandidate", "ListImportResolver.cs:ToDto",
        // These Expected properties belong to connection/playlist synchronization, not Placeholder.
        "ReadyPlaylistHost.cs:Observe", "ArrAdminHubService.cs:Facts",
    };

    [Fact]
    public void RawExpectationFactsCannotBecomeCompletionOrScopeAuthority()
    {
        var violations = new List<string>();
        foreach (var file in Directory.EnumerateFiles(Root(), "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Split(Path.DirectorySeparatorChar).Any(p => p is "obj" or "bin")))
        {
            var name = Path.GetFileName(file);
            var syntax = CSharpSyntaxTree.ParseText(File.ReadAllText(file)).GetRoot();
            foreach (var access in FactReads(syntax))
            {
                if (name == "CompletionEvaluator.cs") continue; // sole evaluator; old negative flag can only deny authority
                var method = access.Ancestors().OfType<MethodDeclarationSyntax>().FirstOrDefault()?.Identifier.Text ?? "<other>";
                if (!DisplayAndStorage.Contains(name + ":" + method)) violations.Add(name + ":" + method + ": " + access);
            }
            // Positive authority can only be constructed by the evaluator (deserialization is the storage boundary).
            foreach (var creation in syntax.DescendantNodes().OfType<ObjectCreationExpressionSyntax>()
                .Where(c => c.Type.ToString() == "CompletionAuthority"))
                if (name != "CompletionEvaluator.cs") violations.Add(name + ": constructs CompletionAuthority");
        }
        Assert.True(violations.Count == 0, string.Join(Environment.NewLine, violations));
        var resolver = File.ReadAllText(Path.Combine(Root(), "Services/Acquire/Lists/ListResolver.cs"));
        Assert.Contains("=> CompletionEvaluator.Read(placeholder, todayUtc).IsComplete", resolver);
        Assert.Contains("=> CompletionEvaluator.Read(placeholder, DateTime.UtcNow).State", resolver);
        var rules = File.ReadAllText(Path.Combine(Root(), "Services/Acquire/Lists/ListRules.cs"));
        Assert.Contains("CompletionEvaluator.ScopeSeasons(placeholder)", rules);
    }

    // Identifier nodes cover normal, conditional and unqualified property access; declarations are tokens, not reads.
    // A plain object-initializer assignment is a write. Qualified reads/writes retain the audited member inventory.
    private static IEnumerable<IdentifierNameSyntax> FactReads(SyntaxNode root) => root.DescendantNodes()
        .OfType<IdentifierNameSyntax>()
        .Where(n => n.Identifier.Text is "Expected" or "EpisodeTotal" or "ExpectedUncertain")
        .Where(n => n.Parent is not AssignmentExpressionSyntax assignment || assignment.Left != n);

    [Fact]
    public void ScanRejectsThePreviousInferenceAndANewCaller()
    {
        var syntax = CSharpSyntaxTree.ParseText("class NewConsumer { bool Complete(Placeholder p) => !p.ExpectedUncertain && p.Expected.Count > 0 && p.EpisodeTotal > 0; }").GetRoot();
        Assert.Equal(3, FactReads(syntax).Count());
        var conditional = CSharpSyntaxTree.ParseText("class NewConsumer { bool Complete(Placeholder p) => p?.ExpectedUncertain == false && p?.Expected?.Count > 0 && p?.EpisodeTotal > 0; }").GetRoot();
        Assert.Equal(3, FactReads(conditional).Count());
        var bare = CSharpSyntaxTree.ParseText("class NewConsumer { bool Complete() => !ExpectedUncertain && Expected.Count > 0 && EpisodeTotal > 0; }").GetRoot();
        Assert.Equal(3, FactReads(bare).Count());
        Assert.DoesNotContain("NewConsumer.cs:Complete", DisplayAndStorage);
    }
}
