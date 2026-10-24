using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.Data.Sqlite;

namespace JE.Tests;

public class IntegrationEditionPreimageJoinTests
{
    private static object? Scalar(string path, string sql)
    {
        using var connection = new SqliteConnection("Data Source=" + path + ";Pooling=False");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return command.ExecuteScalar();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SchemaEightRetryRepairCopiesBeforeEarlierBookkeepingAndEmptyDdl(bool hasChargeOrder)
    {
        using var fixture = new CoreFixture();
        var path = Path.Combine(fixture.Root, "eight.db");
        var input = new MutationInput { Key = "movie:tmdb:42", Scope = "movie", Variant = "standard" };
        using (var connection = new SqliteConnection("Data Source=" + path + ";Pooling=False"))
        {
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = string.Join("\n", AcquireDatabase.Migrations) + "\nPRAGMA user_version=8;";
            command.ExecuteNonQuery();
            if (hasChargeOrder)
            {
                command.CommandText = "ALTER TABLE reservations ADD COLUMN charge_seq INTEGER NOT NULL DEFAULT 0;";
                command.ExecuteNonQuery();
            }
            command.CommandText = @"
INSERT INTO acquisitions VALUES('a','movie:tmdb:42','standard','active',1);
INSERT INTO wants(id,acquisition_id,user_id,client_request_id,fingerprint,title_key,variant,mutation_input,owned_input,status,reason,cost,parental_signature,created_at,updated_at,target_key)
VALUES('w','a','viewer','old','f','movie:tmdb:42','standard',$input,$input,'sent','looking',0,'null',1,1,'pinned-target');
INSERT INTO request_inputs(user_id,client_request_id,fingerprint,want_id) VALUES('viewer','old','f','w');";
            command.Parameters.AddWithValue("$input", input.Canonical);
            command.ExecuteNonQuery();
        }
        Assert.Equal(0L, Scalar(path, "SELECT COUNT(*) FROM meta WHERE key='request_target_repair_v3'"));
        byte[]? originalBytes = null;
        string? originalPath = null;
        for (var pass = 0; pass < 2; pass++)
        {
            using (var database = new AcquireDatabase(path))
            {
                Assert.True(database.Available, database.UnavailableReason);
                Assert.Equal(8, database.Version);
            }
            var copy = Assert.Single(Directory.GetFiles(fixture.Root, "eight.db.pre-v8.*"));
            if (pass == 0) { originalPath = copy; originalBytes = File.ReadAllBytes(copy); }
            else { Assert.Equal(originalPath, copy); Assert.Equal(originalBytes, File.ReadAllBytes(copy)); }
            Assert.Equal(8L, Scalar(copy, "PRAGMA user_version"));
            Assert.Equal(0L, Scalar(copy, "SELECT COUNT(*) FROM meta WHERE key='request_target_repair_v3'"));
            Assert.Equal(hasChargeOrder ? 1L : 0L, Scalar(copy, "SELECT COUNT(*) FROM pragma_table_info('reservations') WHERE name='charge_seq'"));
            Assert.Equal(0L, Scalar(copy, "SELECT COUNT(*) FROM sqlite_master WHERE name='retry_owners'"));
            Assert.Equal(1L, Scalar(copy, "SELECT COUNT(*) FROM request_inputs WHERE want_id='w'"));
        }
        Assert.Equal(1L, Scalar(path, "SELECT COUNT(*) FROM retry_owners"));
    }

    private static List<InvocationExpressionSyntax> Copies(CSharpCompilation source, out MethodDeclarationSyntax initialize)
    {
        var tree = source.SyntaxTrees.Single(t => Path.GetFileName(t.FilePath) == "AcquireDatabase.cs");
        initialize = tree.GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>().Single(m => m.Identifier.ValueText == "Initialize");
        var model = source.GetSemanticModel(tree);
        return initialize.DescendantNodes().OfType<InvocationExpressionSyntax>().Where(call =>
            model.GetSymbolInfo(call).Symbol is IMethodSymbol method && method.Name == "BackupBeforeMigration"
            && method.ContainingType.ToDisplayString() == "Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.AcquireDatabase").ToList();
    }

    [Fact]
    public void ExactlyOneCopyOwnerRunsBeforeNumberedStepsAndRepairs()
    {
        var calls = Copies(ListGateWalk.Plugin.Source, out var initialize);
        var copy = Assert.Single(calls);
        var migrations = initialize.DescendantNodes().OfType<ForStatementSyntax>().First();
        Assert.True(copy.SpanStart < migrations.SpanStart, "The preimage owner precedes every numbered step and additive repair");
    }

    [Fact]
    public void APlantedLateCopyIsRejectedByTheSymbolScan()
    {
        var source = ListGateWalk.Plugin.Source;
        var tree = source.SyntaxTrees.Single(t => Path.GetFileName(t.FilePath) == "AcquireDatabase.cs");
        var before = tree.GetText().ToString();
        var after = before.Replace("_version = UserVersion(connection);", "if (false) BackupBeforeMigration(connection, version);\n_version = UserVersion(connection);", StringComparison.Ordinal);
        Assert.NotEqual(before, after);
        var planted = CSharpSyntaxTree.ParseText(after, (CSharpParseOptions)tree.Options, tree.FilePath);
        Assert.NotEqual(1, Copies(source.ReplaceSyntaxTree(tree, planted), out _).Count);
    }
}
