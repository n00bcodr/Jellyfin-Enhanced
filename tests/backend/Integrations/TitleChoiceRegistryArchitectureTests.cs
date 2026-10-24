using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
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
                if (sql.Contains("title_choices", StringComparison.OrdinalIgnoreCase) || sql.Contains("title_choice_id", StringComparison.OrdinalIgnoreCase) || sql.Contains("title_choice_revision", StringComparison.OrdinalIgnoreCase) ||
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
}
