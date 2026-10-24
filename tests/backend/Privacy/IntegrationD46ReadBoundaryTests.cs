using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace JE.Tests;

public class IntegrationD46ReadBoundaryTests
{
    // Reviewed, method-level ingestion/comparison inventory. No file or directory
    // is exempt: a raw read in any other rule/helper is rejected by its symbol.
    private static readonly Dictionary<string, string> Adapters = new()
    {
        ["SpoilerFieldStripFilter.CaptureSubject"] = "Capture canonical type/id before category and overview verdicts",
        ["SpoilerTagDataStripper.CaptureCategoryIdentity"] = "Resolve a supplied tag entity against canonical typed ownership",
        ["SpoilerNextUnwatchedService.CategoryOf"] = "Owned boundary query accessor with replayable selection evidence",
        ["SpoilerNextUnwatchedService.ComputeNow"] = "Owned live boundary comparison adapter",
        ["PrivacyReads.Numbers"] = "Typed canonical numbering capture with a live query proof",
        ["PrivacyValues.CaptureControlInputs"] = "Freeze host-required control fields without title or library authority",
        ["PrivacyValues.RebuildCaptured"] = "Classified reflection ingestion into the pure rules with explicit captured context",
        ["PrivacyValues.CaptureInputs"] = "Freeze payload primitives and reconcile live library references",
        ["PrivacyValues.CaptureDto"] = "Own the incoming DTO snapshot and canonical references",
        ["PrivacyValues.CapturePairs"] = "Own scalar name/id pair payloads before vocabulary matching",
        ["PrivacyValues.CaptureVersionLabel"] = "Rebuild a source label from selected validated stream tokens",
        ["PrivacyValues.CaptureTagAnswer"] = "Bind selected immutable tag payload to a canonical live reread",
        ["PrivacyValues.CaptureTagPayload"] = "Read only selected tag fields, stream/language and representative fallbacks",
        ["PrivacyValues.Stub"] = "Capture the entry subject identifier",
        ["PrivacyValues.Guarded"] = "Dispatch owned snapshot ingestion and synthetic facade namespace",
        ["PrivacyValues.Hint"] = "Own hint snapshot and canonical numbering/channel inputs",
        ["PrivacyValues.Activity"] = "Capture immutable host event type and deliberately revealed stored name",
        ["PrivacyValues.SitsLikeAnExtra"] = "Host naming adapter; ownership proof includes path",
        ["PrivacyValues.NamedExtraType"] = "Host naming adapter; ownership proof includes path and extra type",
        ["PrivacyValues.ExtraOwnerFolders"] = "Host naming adapter; ownership lookup records chosen owner",
        ["PrivacyValues.ExtraLabel"] = "Ownership adapter constructs closed labels from the captured extra kind",
        ["PrivacyValues.Rebuild"] = "Classified property walk is sole reflection payload ingestion",
        ["PrivacyValues.Admit"] = "Validate the newly rebuilt output person; never the incoming host carrier",
        ["PrivacyValues.Plan"] = "Stable type metadata selects closed construction rules",
        ["PrivacyValues.TagEntry"] = "Clone cache payload; sanitize selected fields against live vocabulary",
        ["PrivacyValues.TagStream"] = "Freeze/cache stream payload into closed token validators",
        ["PrivacyValueHost.Consumed"] = "Record ownership evidence from the canonical item capture",
        ["PrivacyValueHost.Item"] = "Capture canonical item presence and ownership; not a projection value",
        ["PrivacyValueHost.Prefetch"] = "Batch canonical item capture",
        ["PrivacyValueHost.References"] = "Freeze kind/series/season/channel/number and replay live semantic comparison",
        ["PrivacyValueHost.Text"] = "Freeze one consumed text getter with its exact live spelling/presence",
        ["PrivacyValueHost.Entry"] = "Freeze consumed list membership/spelling, excluding unrelated entries",
        ["PrivacyValueHost.Title"] = "Resolve title ownership through judged entities",
        ["PrivacyValueHost.TitleId"] = "Return only the captured owning identifier",
        ["PrivacyValueHost.IsExtra"] = "Return the shared ownership classifier result",
        ["PrivacyValueHost.ExtraName"] = "Construct a closed extra-kind label",
        ["PrivacyValueHost.People"] = "Freeze people query and replay its semantic proof",
        ["PrivacyValueHost.PersonName"] = "Resolve a title identifier through the people capture adapter",
    };

    private static bool Raw(ITypeSymbol? type)
    {
        for (var t = type as INamedTypeSymbol; t != null; t = t.BaseType)
        {
            var name = t.ToDisplayString();
            if (name == "MediaBrowser.Controller.Entities.BaseItem" || name.StartsWith("MediaBrowser.Model.Dto.", StringComparison.Ordinal)
                || name.StartsWith("MediaBrowser.Model.Search.", StringComparison.Ordinal)
                || name.StartsWith("MediaBrowser.Model.LiveTv.", StringComparison.Ordinal)
                || name is "MediaBrowser.Model.Entities.MediaStream" or "MediaBrowser.Model.Dto.MediaSourceInfo"
                    or "MediaBrowser.Model.Entities.ChapterInfo" or "MediaBrowser.Model.Entities.NameGuidPair") return true;
        }
        return false;
    }

    private static List<string> Violations(CSharpCompilation source)
    {
        var failures = new List<string>();
        var queue = new Queue<SyntaxNode>();
        var visited = new HashSet<(SyntaxTree Tree, Microsoft.CodeAnalysis.Text.TextSpan Span)>();
        foreach (var tree in source.SyntaxTrees.Where(t => Path.GetFileName(t.FilePath) is "PrivacyValues.cs" or "PrivacyTagValues.cs"))
            foreach (var member in tree.GetRoot().DescendantNodes().OfType<MemberDeclarationSyntax>())
                if (member is MethodDeclarationSyntax or FieldDeclarationSyntax or PropertyDeclarationSyntax)
                    if (member.Ancestors().OfType<TypeDeclarationSyntax>().FirstOrDefault()?.Identifier.ValueText is "PrivacyValues" or "PrivacyValueHost") queue.Enqueue(member);
        var verdicts = new Dictionary<string, string[]>
        {
            ["SpoilerFieldStripFilter"] = ["Reveal", "RevealFor", "Category", "ResolveCategoryReveal", "ShouldStripOverview"],
            ["SpoilerTagDataStripper"] = ["CategoryReveal", "Reveal"],
        };
        foreach (var tree in source.SyntaxTrees)
            foreach (var method in tree.GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>())
                if (method.Ancestors().OfType<TypeDeclarationSyntax>().FirstOrDefault()?.Identifier.ValueText is { } owner
                    && verdicts.TryGetValue(owner, out var names) && names.Contains(method.Identifier.ValueText)) queue.Enqueue(method);
        while (queue.TryDequeue(out var root))
        {
            if (!visited.Add((root.SyntaxTree, root.Span))) continue;
            var model = source.GetSemanticModel(root.SyntaxTree);
            var declaring = root as MethodDeclarationSyntax ?? root.Ancestors().OfType<MethodDeclarationSyntax>().FirstOrDefault();
            if (declaring != null && model.GetDeclaredSymbol(declaring) is IMethodSymbol adapter
                && Adapters.ContainsKey(adapter.ContainingType.Name + "." + adapter.Name)) continue;
            foreach (var node in root.DescendantNodes().OfType<SimpleNameSyntax>())
            {
                var symbol = model.GetSymbolInfo(node).Symbol;
                // Output writes do not consume a host input.
                if (node.Parent is MemberAccessExpressionSyntax access && access.Parent is AssignmentExpressionSyntax assignment && assignment.Left == access) continue;
                if (node.Parent is AssignmentExpressionSyntax direct && direct.Left == node) continue;
                var raw = symbol switch
                {
                    IPropertySymbol property => Raw(property.ContainingType),
                    IFieldSymbol field => Raw(field.ContainingType),
                    IMethodSymbol call => (call.Name.StartsWith("Get", StringComparison.Ordinal) && call.ContainingNamespace.ToDisplayString().StartsWith("MediaBrowser.Controller", StringComparison.Ordinal))
                        || call.ReducedFrom != null && call.ReducedFrom.Parameters.Any(p => Raw(p.Type))
                        || call.ContainingNamespace.ToDisplayString().StartsWith("System.Reflection", StringComparison.Ordinal) && call.Name is "GetValue" or "Invoke",
                    _ => false,
                };
                if (raw) failures.Add(Path.GetFileName(root.SyntaxTree.FilePath) + ":" + (node.GetLocation().GetLineSpan().StartLinePosition.Line + 1) + " " + symbol!.ToDisplayString());
                if (symbol is IMethodSymbol or IPropertySymbol or IFieldSymbol)
                {
                    var delegated = symbol!;
                    if (delegated.ContainingType != null && Adapters.ContainsKey(delegated.ContainingType.Name + "." + delegated.Name)) continue;
                    foreach (var reference in delegated.DeclaringSyntaxReferences)
                        if (source.SyntaxTrees.Contains(reference.SyntaxTree)) queue.Enqueue(reference.GetSyntax());
                }
            }
        }
        return failures.Distinct().ToList();
    }

    [Fact]
    public void PureConstructionRulesCannotReadMutableDtoOrHostProperties()
    {
        var failures = Violations(ListGateWalk.Plugin.Source);
        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    [Theory]
    [InlineData("((MediaBrowser.Model.Dto.BaseItemDto)v!).Name")]
    [InlineData("new PrivacyValueHost(null, null).Library!.GetItemById(System.Guid.Empty)")]
    public void PlantedPropertyAndHostReadsAreRejected(string expression)
    {
        var source = ListGateWalk.Plugin.Source;
        var tree = source.SyntaxTrees.Single(t => Path.GetFileName(t.FilePath) == "PrivacyValues.cs");
        var before = tree.GetText().ToString();
        var after = before.Replace("(v, _, _) => v);", "(v, _, _) => " + expression + ");", StringComparison.Ordinal);
        Assert.NotEqual(before, after);
        var planted = CSharpSyntaxTree.ParseText(after, (CSharpParseOptions)tree.Options, tree.FilePath);
        Assert.NotEmpty(Violations(source.ReplaceSyntaxTree(tree, planted)));
    }
}
