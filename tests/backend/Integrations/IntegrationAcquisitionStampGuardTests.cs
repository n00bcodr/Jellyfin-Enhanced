using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace JE.Tests;

public class IntegrationAcquisitionStampGuardTests
{
    private static string Folder([System.Runtime.CompilerServices.CallerFilePath] string file = "")
    {
        var root = new DirectoryInfo(Path.GetDirectoryName(file)!);
        while (root != null && !Directory.Exists(Path.Combine(root.FullName, "Jellyfin.Plugin.JellyfinEnhanced"))) root = root.Parent;
        return Path.Combine(root!.FullName, "Jellyfin.Plugin.JellyfinEnhanced/Services/Acquire/Stamps");
    }

    [Fact]
    public void EveryStampDatabaseWriteUsesTheOneGenerationAndDeletionGuard()
    {
        var writes = Directory.GetFiles(Folder(), "*.cs").SelectMany(path =>
            CSharpSyntaxTree.ParseText(File.ReadAllText(path)).GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>()
                .Where(call => call.Expression is MemberAccessExpressionSyntax access && access.Expression.ToString() == "_db"
                    && access.Name.Identifier.Text is "Write" or "WriteIf")
                .Select(call => (Path: path, Call: call))).ToList();
        var write = Assert.Single(writes);
        Assert.EndsWith("AcquisitionStampStore.cs", write.Path, StringComparison.Ordinal);
        Assert.Equal("_db.WriteIf", write.Call.Expression.ToString());
        Assert.Equal("generation", write.Call.ArgumentList.Arguments[0].ToString());
        Assert.Equal("Guard", write.Call.Ancestors().OfType<MethodDeclarationSyntax>().First().Identifier.Text);
        var store = File.ReadAllText(write.Path);
        Assert.Contains("_deleted.ContainsKey(user)", store, StringComparison.Ordinal);
        var feeder = CSharpSyntaxTree.ParseText(File.ReadAllText(Path.Combine(Folder(), "AcquisitionStampFeeder.cs"))).GetRoot();
        var names = new[] { "AddNew", "AddUpgraded", "MarkSeen", "NoteArrival", "ObserveSources" };
        var calls = feeder.DescendantNodes().OfType<InvocationExpressionSyntax>().Where(call => call.Expression is MemberAccessExpressionSyntax a && a.Expression.ToString() == "_store" && names.Contains(a.Name.Identifier.Text)).ToList();
        Assert.NotEmpty(calls);
        Assert.All(calls, call => Assert.Contains(call.ArgumentList.Arguments, arg => arg.NameColon?.Name.Identifier.Text == "generation"));
    }
}
