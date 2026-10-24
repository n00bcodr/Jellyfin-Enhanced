using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace JE.Tests;

/// <summary>
/// R3-S1/D53: inventory writers, not just job creation. Runtime tests prove the held/retry transitions;
/// this source gate makes a new constructor, copy or SQL authorization writer require an explicit review.
/// </summary>
public class RequestChoiceArchitectureTests
{
    private const string Authorization = "Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestAuthorization";
    private const string Ledger = "Services/Acquire/Requests/RequestLedger.cs";

    private static string Owner(SyntaxNode node)
        => node.Ancestors().OfType<MethodDeclarationSyntax>().FirstOrDefault() is { } method
            ? method.Ancestors().OfType<TypeDeclarationSyntax>().First().Identifier.Text + "." + method.Identifier.Text
            : "outside method";

    private static List<string> Problems(WriteGateWalk plugin, string? relative = null)
    {
        var problems = new List<string>();
        foreach (var (tree, model) in relative == null ? plugin.Sources() : new[] { plugin.Source(relative) })
        foreach (var node in tree.GetRoot().DescendantNodes())
        {
            if (node is not (BaseObjectCreationExpressionSyntax or WithExpressionSyntax or LiteralExpressionSyntax)) continue;
            var owner = Owner(node);
            if (node is BaseObjectCreationExpressionSyntax creation && model.GetTypeInfo(creation).Type?.ToDisplayString() == Authorization)
            {
                // Authorize: fresh authority, stamped by AddJob before any executable insert.
                // TargetKey / SeerrTargetKey / Charge / migration: temporary destination-serialization adapters only;
                // they never create a job or replace an existing authorization record.
                if (owner is not ("RequestLedger.Authorize" or "RequestLedger.TargetKey" or "RequestLedger.SeerrTargetKey" or "FutureSeasonCharges.Charge" or "SeerrMigration.CommitAsync"))
                    problems.Add(owner + ": unreviewed authorization constructor");
            }
            if (node is WithExpressionSyntax copy && model.GetTypeInfo(copy).Type?.ToDisplayString() == Authorization)
            {
                // CarryForward preserves an existing job; StampTitleChoice alone creates/advances choice stamps.
                if (owner is not ("RequestAuthorization.CarryForward" or "RequestLedger.StampTitleChoice"))
                    problems.Add(owner + ": unreviewed authorization copy");
            }
            if (node is not LiteralExpressionSyntax literal || literal.Token.Value is not string sql) continue;
            if (Regex.IsMatch(sql, @"INSERT\s+INTO\s+jobs\b", RegexOptions.IgnoreCase))
            {
                if (owner != "RequestLedger.AddJob" || !literal.Ancestors().OfType<MethodDeclarationSyntax>().First()
                    .DescendantNodes().OfType<InvocationExpressionSyntax>().Any(c => model.GetSymbolInfo(c).Symbol is IMethodSymbol { Name: "StampTitleChoice" }))
                    problems.Add(owner + ": new job must use title-choice stamping");
            }
            if (!Regex.IsMatch(sql, @"UPDATE\s+jobs\s+SET\b.*\bauthorization_context\s*=", RegexOptions.IgnoreCase | RegexOptions.Singleline)) continue;
            if (owner == "RequestLedger.ReauthorizeJob")
            {
                var method = literal.Ancestors().OfType<MethodDeclarationSyntax>().First();
                var calls = method.DescendantNodes().OfType<InvocationExpressionSyntax>()
                    .Where(c => model.GetSymbolInfo(c).Symbol is IMethodSymbol { Name: "CarryForward" } symbol && symbol.ContainingType.ToDisplayString() == Authorization).ToArray();
                if (calls.Length != 1 || calls[0].Expression.ToString() != "job.Authorization.CarryForward")
                    problems.Add(owner + ": whole-record rewrite must carry the existing job authorization");
            }
            else if (owner == "RequestLedger.BindSeerrSend" || owner == "RequestLedger.PurgeUser")
            {
                // Existing field-scoped writes: Seerr account/seasons binding, or identity revocation/anonymization.
                // JSON_SET must preserve every other property, including choice fields and unknown legacy properties.
                var expected = owner == "RequestLedger.BindSeerrSend"
                    ? new[] { "SeerrUser", "SeerrSeasons" }
                    : sql.Contains("$.Approver", StringComparison.Ordinal) ? new[] { "Approver" } : new[] { "Requester", "SeerrPermissions" };
                var fields = Regex.Matches(sql, @"'\$\.([A-Za-z]+)'\s*,").Select(m => m.Groups[1].Value).ToArray();
                if (!Regex.IsMatch(sql, @"authorization_context\s*=\s*json_set\(authorization_context,", RegexOptions.IgnoreCase) || !fields.SequenceEqual(expected))
                    problems.Add(owner + ": field-scoped authorization write changed");
            }
            else problems.Add(owner + ": unreviewed SQL authorization writer");
        }
        return problems;
    }

    [Fact]
    public void EveryAuthorizationConstructorCopyAndSqlRewriteHasAnOwner()
    {
        var problems = Problems(WriteGateWalk.Plugin);
        Assert.True(problems.Count == 0, string.Join("\n", problems));
    }

    [Fact]
    public void GateDetectsTheOriginalHeldResumeBypass()
    {
        var bypass = WriteGateWalk.Plugin.With(Ledger, s => s.Replace("job.Authorization.CarryForward(refreshed)", "refreshed", StringComparison.Ordinal));
        Assert.Contains(Problems(bypass, Ledger), p => p.Contains("whole-record rewrite must carry", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("new RequestAuthorization(Guid.Empty, null, \"request\", \"movie\", \"standard\", \"je\", \"r\", \"g\", \"p\")", "constructor")]
    [InlineData("resume.Authorization with { Approver = actor }", "copy")]
    public void GateDetectsAnotherRebuildInTheResumeLoop(string expression, string reason)
    {
        var mutant = WriteGateWalk.Plugin.With(Ledger, s => s.Replace(
            "ReauthorizeJob(c, t, resume, Authorize(requester, approver, resume.Input, edits != null), now)",
            "ReauthorizeJob(c, t, resume, " + expression + ", now)", StringComparison.Ordinal));
        Assert.Contains(Problems(mutant, Ledger), p => p.Contains("unreviewed authorization " + reason, StringComparison.Ordinal));
    }
}
