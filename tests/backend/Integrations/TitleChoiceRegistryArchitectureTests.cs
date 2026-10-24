using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace JE.Tests;

public class TitleChoiceRegistryArchitectureTests
{
    private const string Registry = "Services/Acquire/Requests/TitleChoiceRegistry.cs";
    private const string Ledger = "Services/Acquire/Requests/RequestLedger.cs";
    private static readonly string[] Protected = { "ChoiceOwner", "ChoiceVersion", "TitleChoiceId", "TitleChoiceRevision", "TitleChoiceSettings" };

    internal static List<string> Problems(WriteGateWalk plugin, string? relative = null)
    {
        var problems = new List<string>();
        foreach (var (tree, model) in relative == null ? plugin.Sources() : new[] { plugin.Source(relative) })
        {
            // Permission is part of the writer boundary: an allowlisted API is not permission
            // to manufacture an override token in approval, or an effective value in dispatch.
            foreach (var call in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                var method = model.GetSymbolInfo(call).Symbol as IMethodSymbol;
                var owner = call.Ancestors().OfType<MethodDeclarationSyntax>().FirstOrDefault()?.Identifier.Text;
                if (method?.ContainingType.Name == "TitleChoiceRegistry" && method.Name is "Claim" or "Override" &&
                    !tree.FilePath.Replace('\\', '/').EndsWith(Registry, StringComparison.Ordinal) && owner != "CheckTitleChoice")
                    problems.Add("choice mutation outside explicit admission (approval cannot mint revisions)");
                if (method?.ContainingType.Name == "TitleChoiceRegistry" && method.Name == "Override" && owner == "CheckTitleChoice" &&
                    call.ArgumentList.Arguments[4].Expression.ToString() != "overrideVersion.Value")
                    problems.Add("override revision must be the submitted expected revision");
                if (method?.Name == "CheckTitleChoice" && owner == "ApproveCore" &&
                    (!call.ArgumentList.Arguments[5].Expression.IsKind(SyntaxKind.NullLiteralExpression) ||
                     !call.ArgumentList.Arguments.Any(a => a.NameColon?.Name.Identifier.Text == "allowChanges" && a.Expression.IsKind(SyntaxKind.FalseLiteralExpression))))
                    problems.Add("approval choice admission must be read only");
                if (method?.ContainingType.Name == "TitleChoiceRegistry" && method.Name == "Save" && owner != "CommitChoice")
                    problems.Add("choice change without atomic actor/revision audit");
                if (tree.FilePath.Replace('\\', '/').EndsWith("Services/Acquire/Requests/DirectArrBackend.cs", StringComparison.Ordinal) &&
                    method?.ContainingType.Name == "ArrAddRules" && method.Name == "Check" &&
                    call.ArgumentList.Arguments.Last().Expression.ToString() != "run.Job.TitleChoiceSettings")
                    problems.Add("dispatch must validate the recorded settings");
            }
            if (tree.FilePath.Replace('\\', '/').EndsWith("Services/Acquire/Requests/RequestLedgerTitles.cs", StringComparison.Ordinal) &&
                !tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>().Any(call =>
                    model.GetSymbolInfo(call).Symbol is IMethodSymbol { Name: "FenceSplit", ContainingType.Name: "TitleChoiceRegistry" }))
                problems.Add("contradictory identity learning must reach the registry split fence");
            if (tree.FilePath.Replace('\\', '/').EndsWith("Services/Acquire/Requests/DirectArrBackend.cs", StringComparison.Ordinal))
                foreach (var member in tree.GetRoot().DescendantNodes().Where(n => n is MemberAccessExpressionSyntax or MemberBindingExpressionSyntax))
                    if (model.GetSymbolInfo(member).Symbol is IPropertySymbol p && p.ContainingType.Name == "ArrInstanceDefaults" && p.Name is "QualityProfileId" or "RootFolderPath")
                        problems.Add("dispatch default fill outside registry");
            if (tree.FilePath.Replace('\\', '/').EndsWith("Services/Acquire/Requests/ArrAddRules.cs", StringComparison.Ordinal))
            {
                var check = tree.GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>().Single(x => x.Identifier.Text == "Check");
                foreach (var name in new[] { "profile", "root" })
                {
                    var declaration = check.DescendantNodes().OfType<VariableDeclaratorSyntax>().Single(x => x.Identifier.Text == name);
                    if (declaration.Initializer?.Value is not ConditionalExpressionSyntax conditional ||
                        conditional.Condition.ToString() != "ownedSettings != null" ||
                        conditional.WhenTrue.DescendantNodesAndSelf().Any(n => n is BinaryExpressionSyntax b && b.IsKind(SyntaxKind.CoalesceExpression)))
                        problems.Add("recorded dispatch field must refuse an absent value, never fill defaults");
                }
            }
            if (tree.FilePath.Replace('\\', '/').EndsWith(Registry, StringComparison.Ordinal)) continue;
            foreach (var node in tree.GetRoot().DescendantNodes())
            {
                if (node is BaseObjectCreationExpressionSyntax or WithExpressionSyntax &&
                    model.GetTypeInfo(node).Type?.Name == "TitleChoiceRecord")
                    problems.Add("owned record construction/copy outside registry");
                if (node is AssignmentExpressionSyntax assignment && model.GetSymbolInfo(assignment.Left).Symbol is IPropertySymbol property &&
                    (property.ContainingType.Name == "TitleChoiceRecord" ||
                     property.ContainingType.Name is "RequestAuthorization" or "RequestJob" && Protected.Contains(property.Name)))
                    problems.Add("owned field outside registry: " + property.Name);
                // Inspect constant expression values, including concatenated SQL, rather than a writer-path allowlist.
                if (node is not (LiteralExpressionSyntax or BinaryExpressionSyntax or InterpolatedStringExpressionSyntax) || node is not ExpressionSyntax expression || !model.GetConstantValue(expression).HasValue || model.GetConstantValue(expression).Value is not string sql) continue;
                if (sql.Contains("title_choices", StringComparison.OrdinalIgnoreCase) || sql.Contains("title_choice_audit", StringComparison.OrdinalIgnoreCase) || sql.Contains("title_identity_fences", StringComparison.OrdinalIgnoreCase) || sql.Contains("title_choice_id", StringComparison.OrdinalIgnoreCase) || sql.Contains("title_choice_revision", StringComparison.OrdinalIgnoreCase) ||
                    Regex.IsMatch(sql, @"\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO|ALTER\s+TABLE)\s+[\[""`]*title_choices\b", RegexOptions.IgnoreCase) ||
                    Regex.IsMatch(sql, @"\bUPDATE\s+jobs\s+SET\b.*\btitle_choice_(?:id|revision)\s*=", RegexOptions.IgnoreCase | RegexOptions.Singleline) ||
                    Regex.IsMatch(sql, @"\$\.(?:ChoiceOwner|ChoiceVersion)", RegexOptions.IgnoreCase))
                    problems.Add("owned SQL write outside registry");
            }
        }
        return problems.Distinct().ToList();
    }

    [Fact]
    public void RegistryIsTheOnlyOwnedRecordFieldAndSqlWriter()
    {
        var problems = Problems(WriteGateWalk.Plugin);
        Assert.True(problems.Count == 0, string.Join("\n", problems));
        Assert.Contains(WriteGateWalk.Plugin.Sources(), s => s.Item1.FilePath.EndsWith(Registry, StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("auth = auth with { ChoiceOwner = Guid.Empty };", "owned field")]
    [InlineData("var hacked = new TitleChoiceRecord(\"id\", \"tv:tvdb:1\", \"dest\", Guid.Empty, 1, 4, \"/selected\", Array.Empty<int>(), null, null);", "owned record")]
    [InlineData("var hacked = new TitleChoiceRecord(\"id\", \"tv:tvdb:1\", \"dest\", Guid.Empty, 1, 4, \"/selected\", Array.Empty<int>(), null, null) with { RootFolder = \"/other\" };", "owned field")]
    [InlineData("Exec(c, t, \"UPDATE title_choices SET value='replacement'\");", "owned SQL")]
    [InlineData("Exec(c, t, \"UPDATE jobs SET title_choice_revision=42\");", "owned SQL")]
    [InlineData("var table = \"title_choices\"; Exec(c, t, \"UPDATE \" + table + \" SET value='replacement'\");", "owned SQL")]
    public void GateRejectsPlantedDirectWrites(string planted, string expected)
    {
        var mutant = WriteGateWalk.Plugin.With(Ledger, s => s.Replace("var binding = TitleChoiceRegistry.Bind(c, t, input, auth, defaults);",
            planted + "\n var binding = TitleChoiceRegistry.Bind(c, t, input, auth, defaults);", StringComparison.Ordinal));
        Assert.Contains(Problems(mutant, Ledger), p => p.Contains(expected, StringComparison.Ordinal));
    }

    [Fact]
    public void GateRejectsPlantedApprovalTimeRevisionBump()
    {
        var mutant = WriteGateWalk.Plugin.With(Ledger, s => s.Insert(
            s.IndexOf("var jobs = Jobs(c, t, \"want_id=$id\", (\"$id\", id));", StringComparison.Ordinal),
            "TitleChoiceRegistry.Override(c, t, input, Authorize(requester, approver, input, true), TitleChoiceRegistry.Current(c, t, input, Authorize(requester, approver, input, true))!.Revision, actor);\n "));
        Assert.True(mutant.Errors(Ledger).Count == 0, string.Join("\n", mutant.Errors(Ledger)));
        Assert.Contains(Problems(mutant, Ledger), p => p.Contains("approval cannot mint revisions", StringComparison.Ordinal));
    }

    [Fact]
    public void GateRejectsPlantedDispatchTimeDefaultFill()
    {
        const string backend = "Services/Acquire/Requests/DirectArrBackend.cs";
        var mutant = WriteGateWalk.Plugin.With(backend, s => s.Replace(
            "run.Job.Input.RootFolder, run.Job.TitleChoiceSettings)",
            "run.Job.Input.RootFolder ?? run.Instance.Defaults?.RootFolderPath, run.Job.TitleChoiceSettings)", StringComparison.Ordinal));
        Assert.Empty(mutant.Errors(backend));
        Assert.Contains(Problems(mutant, backend), p => p.Contains("dispatch default fill", StringComparison.Ordinal));
    }

    [Fact]
    public void GateRejectsPlantedSharedRuleDefaultFill()
    {
        const string rules = "Services/Acquire/Requests/ArrAddRules.cs";
        var mutant = WriteGateWalk.Plugin.With(rules, s => s.Replace(
            "ownedSettings != null ? rootFolder : rootFolder ?? saved?.RootFolderPath",
            "rootFolder ?? saved?.RootFolderPath", StringComparison.Ordinal));
        Assert.Empty(mutant.Errors(rules));
        Assert.Contains(Problems(mutant, rules), p => p.Contains("never fill defaults", StringComparison.Ordinal));
    }

    [Fact]
    public void GateRejectsPlantedMissingIdentitySplitFence()
    {
        const string titles = "Services/Acquire/Requests/RequestLedgerTitles.cs";
        var mutant = WriteGateWalk.Plugin.With(titles, s => s.Replace("TitleChoiceRegistry.FenceSplit(c, t, given);", "", StringComparison.Ordinal));
        Assert.Empty(mutant.Errors(titles));
        Assert.Contains(Problems(mutant, titles), p => p.Contains("registry split fence", StringComparison.Ordinal));
    }
}
