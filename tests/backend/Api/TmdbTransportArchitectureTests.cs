using System.Security.Cryptography;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace JE.Tests;

// Positive sink inventory, independent of caller/starter names. Every HTTP send and request/client
// construction is either inside the sole TMDB transport or in a reviewed, body-pinned non-TMDB
// method. Changing a generic HTTP method invalidates its exception, forcing a new host review.
public class TmdbTransportArchitectureTests
{
    private static string Root => IntegrationAutoRequestLedgerTests.Root();
    private static string Inventory => Path.Combine(Root, "tests/fixtures/tmdb-nonmetadata-http.tsv");
    private static readonly string[] Owners =
    {
        "Services/NativeDetails/ViewerMetadataAdmission.cs::Run",
        "Services/AutonomousMetadataAdmission.cs::RunAsync",
        "Services/Acquire/Lists/ListMetadata.cs::TmdbPosterAsync",
    };

    private static string Location(SyntaxNode node)
    {
        var path = Path.GetRelativePath(Path.Combine(Root, "Jellyfin.Plugin.JellyfinEnhanced"), node.SyntaxTree.FilePath).Replace('\\', '/');
        var method = node.AncestorsAndSelf().OfType<BaseMethodDeclarationSyntax>().FirstOrDefault();
        var name = method is MethodDeclarationSyntax m ? m.Identifier.ValueText : method is ConstructorDeclarationSyntax c ? c.Identifier.ValueText : "<initializer>";
        return path + "::" + name;
    }

    internal static Dictionary<string, string> HttpSites(CSharpCompilation compilation)
    {
        var sites = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var tree in compilation.SyntaxTrees)
        {
            var model = compilation.GetSemanticModel(tree);
            foreach (var node in tree.GetRoot().DescendantNodes().Where(n => n is InvocationExpressionSyntax or BaseObjectCreationExpressionSyntax))
            {
                var symbol = model.GetSymbolInfo(node).Symbol as IMethodSymbol;
                var type = symbol?.ContainingType.ToDisplayString();
                var isHttp = symbol?.Name != nameof(IDisposable.Dispose) && type is "System.Net.Http.HttpClient" or "System.Net.Http.HttpMessageInvoker"
                    or "System.Net.Http.HttpMessageHandler" or "System.Net.Http.HttpRequestMessage"
                    or "System.Net.Http.IHttpClientFactory" or "System.Net.Http.HttpClientFactoryExtensions"
                    or "System.Net.Http.Json.HttpClientJsonExtensions";
                var isBodySend = type == "Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.BoundedBody" && symbol?.Name == "SendAsync";
                if (!isHttp && !isBodySend) continue;
                var location = Location(node);
                if (location.StartsWith("Services/TmdbTransport.cs::", StringComparison.Ordinal)) continue;
                var method = node.AncestorsAndSelf().OfType<BaseMethodDeclarationSyntax>().FirstOrDefault();
                var body = (SyntaxNode?)method ?? node;
                var normalized = string.Join(" ", body.DescendantTokens().Select(t => t.Text));
                sites[location] = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)));
            }
        }
        return sites;
    }

    private static List<string> Scan(CSharpCompilation compilation)
    {
        var allowed = File.ReadAllLines(Inventory).Where(l => l.Length > 0 && !l.StartsWith('#')).Select(l => l.Split('\t')).ToDictionary(c => c[0], c => c[1]);
        var errors = HttpSites(compilation).Where(p => !allowed.TryGetValue(p.Key, out var hash) || hash != p.Value).Select(p => "unreviewed HTTP: " + p.Key).ToList();
        foreach (var tree in compilation.SyntaxTrees)
        {
            var model = compilation.GetSemanticModel(tree);
            foreach (var method in tree.GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>()
                .Where(m => m.Parent is ClassDeclarationSyntax c && c.Identifier.ValueText == "TmdbTransport" && m.Identifier.ValueText is "SendAsync" or "GetAsync"))
                if (!method.ParameterList.Parameters.Any(p => p.Default == null && p.Type != null && model.GetTypeInfo(p.Type).Type?.Name == "MetadataAdmission"))
                    errors.Add("transport send lacks required typed admission: " + Location(method));
            foreach (var node in tree.GetRoot().DescendantNodes().OfType<BaseObjectCreationExpressionSyntax>())
                if ((model.GetSymbolInfo(node).Symbol as IMethodSymbol)?.ContainingType.Name == "MetadataAdmission" && !Owners.Contains(Location(node)))
                    errors.Add("unowned admission: " + Location(node));
        }
        return errors;
    }

    [Fact]
    public void TmdbArchitectureOnlyTransportSendsAndOnlyDocumentedOwnersConstructAdmission()
    {
        var compilation = WriteGateWalk.Plugin.Compilation;
        Assert.Empty(Scan(compilation));
    }

    private static CSharpCompilation Plant(string body)
    {
        var tree = CSharpSyntaxTree.ParseText("using System; using System.Net.Http; using System.Threading; using System.Threading.Tasks; using Jellyfin.Plugin.JellyfinEnhanced.Services; class Plant { " + body + " }", path: Path.Combine(Root, "Jellyfin.Plugin.JellyfinEnhanced/Services/Plant.cs"));
        return WriteGateWalk.Plugin.Compilation.AddSyntaxTrees(tree);
    }

    [Fact]
    public void TmdbArchitecturePlantDirectTmdbHttpClientIsRejected()
        => Assert.Contains(Scan(Plant("async Task Read() { using var client = new HttpClient(); await client.GetAsync(\"https://api.themoviedb.org/3/genre/movie/list\"); }")), e => e.Contains("unreviewed HTTP: Services/Plant.cs::Read"));

    [Fact]
    public void TmdbArchitecturePlantAdmissionOutsideOwnerIsRejected()
        => Assert.Contains(Scan(Plant("void Read() { using var admission = new MetadataAdmission(\"fake\"); }")), e => e.Contains("unowned admission: Services/Plant.cs::Read"));
}
