using System.Security.Cryptography;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace JE.Tests;

// Every HTTP construction/send is inventoried, including image.tmdb.org and aliases hidden in
// dynamic URLs. Exceptions bind file + fully qualified semantic signature + every declaration body.
public class TmdbTransportArchitectureTests
{
    private static string Root => IntegrationAutoRequestLedgerTests.Root();
    private static string Inventory => Path.Combine(Root, "tests/fixtures/tmdb-nonmetadata-http.tsv");
    private static readonly string[] Owners = {
        "Services/Acquire/Lists/ListMetadata.cs::TmdbPosterAsync|M:Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListMetadataService.TmdbPosterAsync(System.String,Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.AnswerRequest,System.String,System.Threading.CancellationToken)",
        "Services/AutonomousMetadataAdmission.cs::RunAsync|M:Jellyfin.Plugin.JellyfinEnhanced.Services.AutonomousMetadataAdmission.RunAsync``1(Jellyfin.Plugin.JellyfinEnhanced.Services.AutonomousMetadataOwner,System.Func{System.Threading.Tasks.Task{``0}},System.Threading.CancellationToken)",
        "Services/NativeDetails/ImageMetadataAdmission.cs::RunAsync|M:Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails.ImageMetadataAdmission.RunAsync(System.String,System.Guid,System.Func{System.Threading.Tasks.Task{System.Nullable{System.ValueTuple{System.Byte[],System.String}}}},System.Threading.Tasks.TaskCompletionSource{System.Nullable{System.ValueTuple{System.Byte[],System.String}}})",
        "Services/NativeDetails/ViewerMetadataAdmission.cs::Run|M:Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails.ViewerMetadataAdmission.Run``1(System.String,System.Guid,System.Func{System.Threading.Tasks.Task{``0}},System.Threading.Tasks.TaskCompletionSource{``0})"
     };
    private static readonly string[] Transport = {
        "Services/TmdbTransport.cs::SendAsync|M:Jellyfin.Plugin.JellyfinEnhanced.Services.TmdbTransport.SendAsync(System.Net.Http.IHttpClientFactory,System.Net.Http.HttpRequestMessage,Jellyfin.Plugin.JellyfinEnhanced.Services.MetadataAdmission,System.Threading.CancellationToken,System.String,System.Action)",
        "Services/TmdbTransport.cs::GetAsync|M:Jellyfin.Plugin.JellyfinEnhanced.Services.TmdbTransport.GetAsync(System.Net.Http.IHttpClientFactory,System.String,Jellyfin.Plugin.JellyfinEnhanced.Services.MetadataAdmission,System.Threading.CancellationToken,System.String,System.Boolean,System.Action{System.Net.Http.HttpRequestMessage},System.Action)"
     };

    private static BaseMethodDeclarationSyntax? Body(SyntaxNode node)
        => node.AncestorsAndSelf().OfType<BaseMethodDeclarationSyntax>().FirstOrDefault();

    private static string Location(SyntaxNode node)
    {
        var path = Path.GetRelativePath(Path.Combine(Root, "Jellyfin.Plugin.JellyfinEnhanced"), node.SyntaxTree.FilePath).Replace('\\', '/');
        var method = Body(node);
        var name = method is MethodDeclarationSyntax m ? m.Identifier.ValueText : method is ConstructorDeclarationSyntax c ? c.Identifier.ValueText : "<initializer>";
        return path + "::" + name;
    }

    internal static string Identity(SyntaxNode node, SemanticModel model)
    {
        var symbol = Body(node) is { } body ? model.GetDeclaredSymbol(body) : model.GetEnclosingSymbol(node.SpanStart);
        return Location(node) + "|" + (symbol?.GetDocumentationCommentId() ?? symbol?.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) ?? "<unbound>");
    }

    // A generic sender needs no host exemption when its immutable local receiver is obtained
    // through the runtime guard. This rule is structural, not a method-name/body exception.
    private static bool GuardedSender(SyntaxNode node, SemanticModel model)
    {
        if (Body(node) is not { } body) return false;
        var sends = body.DescendantNodes().OfType<InvocationExpressionSyntax>().Where(call =>
            (model.GetSymbolInfo(call).Symbol as IMethodSymbol)?.ContainingType.ToDisplayString() == "System.Net.Http.HttpClient"
            && (model.GetSymbolInfo(call).Symbol as IMethodSymbol)?.Name != "Dispose").ToArray();
        if (sends.Length == 0) return false;
        return sends.All(call => call.Expression is MemberAccessExpressionSyntax { Expression: IdentifierNameSyntax receiver }
            && model.GetSymbolInfo(receiver).Symbol is ILocalSymbol local
            && local.DeclaringSyntaxReferences.Single().GetSyntax() is VariableDeclaratorSyntax { Initializer.Value: InvocationExpressionSyntax acquisition }
            && (model.GetSymbolInfo(acquisition).Symbol as IMethodSymbol)?.ContainingType.ToDisplayString() is
                "Jellyfin.Plugin.JellyfinEnhanced.Services.PluginHttp" or "Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr.SeerrHttpHelper"
            && !body.DescendantNodes().OfType<AssignmentExpressionSyntax>().Any(a => SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(a.Left).Symbol, local)));
    }

    internal static Dictionary<string, string> HttpSites(CSharpCompilation compilation)
    {
        var bodies = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var transport = compilation.GetTypeByMetadataName("Jellyfin.Plugin.JellyfinEnhanced.Services.TmdbTransport");
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
                if (GuardedSender(node, model)) continue;
                var identity = Identity(node, model);
                var body = (SyntaxNode?)Body(node) ?? node;
                var owner = Body(node) is { } declaration ? model.GetDeclaredSymbol(declaration) : null;
                if (SymbolEqualityComparer.Default.Equals(owner?.ContainingType, transport) && Transport.Contains(identity)) continue;
                if (!bodies.TryGetValue(identity, out var declarations)) bodies.Add(identity, declarations = new(StringComparer.Ordinal));
                // No method-name dictionary overwrites: all bodies belonging to a semantic signature
                // participate, and overloads/foreign containing types have distinct identities.
                var normalized = string.Join(" ", body.DescendantTokens().Select(t => t.Text));
                declarations.Add(normalized);
            }
        }
        return bodies.ToDictionary(p => p.Key, p =>
        {
            var normalized = string.Join("\n", p.Value.Order(StringComparer.Ordinal));
            return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)));
        }, StringComparer.Ordinal);
    }

    private static List<string> Scan(CSharpCompilation compilation)
    {
        var allowed = File.ReadAllLines(Inventory).Concat(File.ReadAllLines(Path.Combine(Root, "tests/fixtures/tmdb-transport-primitives.tsv"))).Where(l => l.Length > 0 && !l.StartsWith('#')).Select(l => l.Split('\t')).ToDictionary(c => c[0], c => c[1]);
        var errors = HttpSites(compilation).Where(p => !allowed.TryGetValue(p.Key, out var hash) || hash != p.Value).Select(p => "unreviewed HTTP: " + p.Key).ToList();
        var admission = compilation.GetTypeByMetadataName("Jellyfin.Plugin.JellyfinEnhanced.Services.MetadataAdmission");
        var transport = compilation.GetTypeByMetadataName("Jellyfin.Plugin.JellyfinEnhanced.Services.TmdbTransport");
        foreach (var tree in compilation.SyntaxTrees)
        {
            var model = compilation.GetSemanticModel(tree);
            foreach (var method in tree.GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>())
            {
                var owner = model.GetDeclaredSymbol(method);
                if (SymbolEqualityComparer.Default.Equals(owner?.ContainingType, transport) && method.Identifier.ValueText is "SendAsync" or "GetAsync")
                    if (owner == null || !owner.Parameters.Any(p => !p.IsOptional && SymbolEqualityComparer.Default.Equals(p.Type, admission)))
                        errors.Add("transport send lacks required typed admission: " + Identity(method, model));
            }
            foreach (var call in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (model.GetSymbolInfo(call).Symbol is not IMethodSymbol method) continue;
                var caller = model.GetEnclosingSymbol(call.SpanStart)?.ContainingType;
                if (method.Name == "CreateClient" && method.ContainingType.ToDisplayString() is "System.Net.Http.IHttpClientFactory" or "System.Net.Http.HttpClientFactoryExtensions"
                    && caller?.ToDisplayString() != "Jellyfin.Plugin.JellyfinEnhanced.Services.PluginHttp")
                    errors.Add("factory acquisition outside runtime egress: " + Identity(call, model));
                if (method.Name == "CopyOptions" && method.ContainingType.ToDisplayString() == "Jellyfin.Plugin.JellyfinEnhanced.Services.TmdbEgressHandler"
                    && (model.GetEnclosingSymbol(call.SpanStart) as IMethodSymbol)?.GetDocumentationCommentId()
                        != "M:Jellyfin.Plugin.JellyfinEnhanced.Services.PluginHttp.FactoryClientHandler.Copy(System.Net.Http.HttpRequestMessage)")
                    errors.Add("egress wire copy outside private adapter: " + Identity(call, model));
                if (method.Name == "Attach" && method.ContainingType.ToDisplayString() == "Jellyfin.Plugin.JellyfinEnhanced.Services.TmdbEgressHandler"
                    && !SymbolEqualityComparer.Default.Equals(caller, transport))
                    errors.Add("egress capability outside transport: " + Identity(call, model));
            }
            foreach (var node in tree.GetRoot().DescendantNodes().OfType<BaseObjectCreationExpressionSyntax>())
                if (SymbolEqualityComparer.Default.Equals((model.GetSymbolInfo(node).Symbol as IMethodSymbol)?.ContainingType, admission) && !Owners.Contains(Identity(node, model)))
                    errors.Add("unowned admission: " + Identity(node, model));
        }
        return errors;
    }

    [Fact]
    public void TmdbArchitectureOnlyTransportSendsAndOnlyDocumentedOwnersConstructAdmission()
        => Assert.Empty(Scan(WriteGateWalk.Plugin.Compilation));

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

    [Theory]
    [InlineData("image.tmdb.org")]
    [InlineData("images.tmdb.org")]
    public void TmdbArchitecturePlantDirectImageFetchIsRejected(string host)
        => Assert.Contains(Scan(Plant("async Task Read() { using var client = new HttpClient(); await client.GetByteArrayAsync(\"https://" + host + "/t/p/w300/a.jpg\"); }")), e => e.Contains("unreviewed HTTP: Services/Plant.cs::Read"));

    [Fact]
    public void TmdbArchitecturePlantSameNameSenderOverloadIsRejected()
    {
        var walk = WriteGateWalk.Plugin;
        var (tree, _) = walk.Source("Services/CdnAssetService.cs");
        var root = tree.GetRoot();
        var type = root.DescendantNodes().OfType<ClassDeclarationSyntax>().Single(c => c.Identifier.ValueText == "CdnAssetService");
        var method = SyntaxFactory.ParseMemberDeclaration("internal static async System.Threading.Tasks.Task<string> FetchAsync(System.Net.Http.IHttpClientFactory factory, int id) { using var client = new System.Net.Http.HttpClient(); return await client.GetStringAsync(\"https://api.themoviedb.org/3/movie/\" + id); }")!;
        var planted = tree.WithRootAndOptions(root.ReplaceNode(type, type.WithMembers(type.Members.Insert(0, method))), tree.Options);
        var compilation = walk.Compilation.ReplaceSyntaxTree(tree, planted);
        AssertNoPlantErrors(compilation, planted);
        Assert.Contains(Scan(compilation), e => e.Contains("unreviewed HTTP: Services/CdnAssetService.cs::FetchAsync"));
    }

    [Fact]
    public void TmdbArchitecturePlantForeignAdmissionOwnerIsRejected()
    {
        var walk = WriteGateWalk.Plugin;
        var (tree, _) = walk.Source("Services/AutonomousMetadataAdmission.cs");
        var source = tree.GetText() + "\nnamespace Reviewer { class AutonomousMetadataAdmission { void RunAsync() { using var admission = new Jellyfin.Plugin.JellyfinEnhanced.Services.MetadataAdmission(\"unowned\"); } } }";
        var planted = CSharpSyntaxTree.ParseText(source, (CSharpParseOptions)tree.Options, tree.FilePath);
        var compilation = walk.Compilation.ReplaceSyntaxTree(tree, planted);
        AssertNoPlantErrors(compilation, planted);
        Assert.Contains(Scan(compilation), e => e.Contains("unowned admission: Services/AutonomousMetadataAdmission.cs::RunAsync"));
    }

    private static void AssertNoPlantErrors(CSharpCompilation compilation, SyntaxTree tree)
        => Assert.Empty(compilation.GetSemanticModel(tree).GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error && d.Id != "CS0619"));
}
