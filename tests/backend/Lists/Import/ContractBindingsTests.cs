using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Xunit.Abstractions;

namespace JE.Tests;

// Review round 10 (D53 "derived request bindings"), the META-TEST: every contract of a provider answer binds EVERY request fact
// (the answer field that echoes it, or a named reason why none can); the binder is checked per binding, generated from the
// table itself; and the behavioural model (ListsSourceReviewR10FixTests) drives every echo binding through a production reader.
public class ContractBindingsTests(ITestOutputHelper output)
{
    private static readonly RequestFact[] Facts = Enum.GetValues<RequestFact>();

    // Stands for an explicit JSON null in a generated answer.
    private static readonly JsonNode NullMarker = JsonValue.Create("<null>")!;

    public static IEnumerable<object[]> Pairs() =>
        from contract in ResponseContract.All
        from fact in Facts
        select new object[] { contract.Name, fact.ToString() };

    private static ResourceSchema Contract(string name) => ResponseContract.All.Single(c => c.Name == name);

    // Every (contract × fact) pair is declared: an echo with at least one path (and, when every path is optional, the reason
    // the fact is bound without one), a route, or a named N/A with its reason.
    [Theory]
    [MemberData(nameof(Pairs))]
    public void EveryContractBindsEveryRequestFact(string contractName, string factName)
    {
        var contract = Contract(contractName);
        var fact = Enum.Parse<RequestFact>(factName);
        Assert.True(contract.Bindings != null && contract.Bindings.TryGetValue(fact, out _), contractName + " doesn't declare " + factName);
        var binding = contract.Bindings![fact];
        output.WriteLine(contractName + " × " + factName + ": " + binding.Kind + " " + string.Join(", ", binding.Paths.Select(p => p.Path + (p.Required ? "" : "?"))) + " " + binding.Reason);
        switch (binding.Kind)
        {
            case BindingKind.Echo:
                Assert.NotEmpty(binding.Paths);
                if (binding.Paths.All(p => !p.Required))
                {
                    Assert.False(string.IsNullOrWhiteSpace(binding.Reason), "an echo without a required path names what binds the fact");
                }

                break;
            default:
                Assert.Empty(binding.Paths);
                Assert.False(string.IsNullOrWhiteSpace(binding.Reason), "a route or N/A binding names its reason");
                break;
        }

        Assert.Equal(fact == RequestFact.Kind, binding.Kind == BindingKind.Route);
    }

    [Fact]
    public void TheContractNamesAreUnique() => Assert.Equal(ResponseContract.All.Count, ResponseContract.All.Select(c => c.Name).Distinct().Count());

    // No contract escapes the table: every public schema of ResponseContract is listed in All.
    [Fact]
    public void EveryPublicContractIsInTheTable()
    {
        var declared = typeof(ResponseContract).GetFields(BindingFlags.Public | BindingFlags.Static).Where(f => f.FieldType == typeof(ResourceSchema)).Select(f => ((ResourceSchema)f.GetValue(null)!).Name).ToList();
        Assert.NotEmpty(declared);
        Assert.Empty(declared.Except(ResponseContract.All.Select(c => c.Name)));
    }

    // Every production validation site validates against a listed contract (a source scan supplementing the runtime model).
    [Fact]
    public void EveryProductionValidationIsByAListedContract()
    {
        var dir = Directory.GetDirectories(FindRepo(), "Services", SearchOption.TopDirectoryOnly).Single();
        var names = typeof(ResponseContract).GetFields(BindingFlags.Public | BindingFlags.Static).Where(f => f.FieldType == typeof(ResourceSchema)).Select(f => f.Name).ToHashSet();
        var used = Directory.GetFiles(dir, "*.cs", SearchOption.AllDirectories)
            .SelectMany(f => Regex.Matches(File.ReadAllText(f), @"ResponseContract\.(\w+)\.(Validate|Read)\(").Select(m => m.Groups[1].Value))
            .Distinct().ToList();
        output.WriteLine(string.Join(", ", used));
        Assert.NotEmpty(used);
        Assert.Empty(used.Except(names));
    }

    private static string FindRepo([System.Runtime.CompilerServices.CallerFilePath] string caller = "")
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(caller)!);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "Jellyfin.Plugin.JellyfinEnhanced")))
        {
            dir = dir.Parent;
        }

        return Path.Combine(dir!.FullName, "Jellyfin.Plugin.JellyfinEnhanced");
    }

    // ── The binder, generated per echo binding: the answer that echoes every path is bound; another value is the binding's
    // mismatch verdict; a required path removed (on the answer or on a row) is UNBOUND; an optional one removed stays bound. ──

    public static IEnumerable<object[]> EchoBindings() =>
        from contract in ResponseContract.All
        from binding in contract.Bindings!
        where binding.Value.Kind == BindingKind.Echo
        select new object[] { contract.Name, binding.Key.ToString() };

    [Theory]
    [MemberData(nameof(EchoBindings))]
    public void TheBinderChecksEveryEchoPath(string contractName, string factName)
    {
        var contract = Contract(contractName);
        var fact = Enum.Parse<RequestFact>(factName);
        var binding = contract.Bindings![fact];
        var (asked, value, other) = Values(fact);
        var request = Ask(fact, asked);

        string Answer(Func<EchoPath, JsonNode?> leaf)
        {
            var root = new JsonObject();
            foreach (var path in binding.Paths)
            {
                if (leaf(path) is { } node)
                {
                    Put(root, path.Path, ReferenceEquals(node, NullMarker) ? null : node);
                }
            }

            return root.ToJsonString();
        }

        ContractRead Bind(string json)
        {
            var read = new ContractRead();
            using var doc = JsonDocument.Parse(json);
            ResponseContract.Bind(contract, request, doc.RootElement, read);
            return read;
        }

        var bound = Bind(Answer(_ => value.DeepClone()));
        Assert.Equal(ResponseVerdict.Valid, bound.Verdict);
        Assert.False(bound.Unbound);

        foreach (var path in binding.Paths)
        {
            var mismatched = Bind(Answer(p => p == path ? other.DeepClone() : value.DeepClone()));
            output.WriteLine(contractName + " × " + factName + " " + path.Path + " → " + mismatched.Verdict + " (" + mismatched.Reason + ")");
            Assert.Equal(binding.OnMismatch, mismatched.Verdict);
            Assert.DoesNotContain(Values(fact).Other.ToJsonString().Trim('"'), mismatched.Reason ?? string.Empty, StringComparison.Ordinal); // a code, never the value

            var removed = Bind(Answer(p => p == path ? null : value.DeepClone()));
            Assert.Equal(path.Required, removed.Unbound);
            Assert.Equal(path.Required ? ResponseVerdict.Partial : ResponseVerdict.Valid, removed.Verdict);

            var nulled = Bind(Answer(p => p == path ? NullMarker : value.DeepClone()));
            Assert.Equal(path.Required, nulled.Unbound);
        }

        // A fact the request doesn't name is never asked about.
        var unasked = new ContractRead();
        using (var doc = JsonDocument.Parse(Answer(_ => other.DeepClone())))
        {
            ResponseContract.Bind(contract, AnswerRequest.None, doc.RootElement, unasked);
        }

        Assert.Equal(ResponseVerdict.Valid, unasked.Verdict);
    }

    // A request naming another kind is refused by every contract.
    [Theory]
    [MemberData(nameof(Contracts))]
    public void ARequestOfAnotherKindIsRefused(string contractName)
    {
        var contract = Contract(contractName);
        Assert.Equal(ResponseVerdict.Malformed, BindKind(contract, "another kind"));
        Assert.Equal(ResponseVerdict.Valid, BindKind(contract, contract.Name));
    }

    public static IEnumerable<object[]> Contracts() => ResponseContract.All.Select(c => new object[] { c.Name });

    private static ResponseVerdict BindKind(ResourceSchema contract, string kind)
    {
        var read = new ContractRead();
        using var doc = JsonDocument.Parse("{}");
        ResponseContract.Bind(contract, new AnswerRequest { Kind = kind }, doc.RootElement, read);
        return read.Verdict;
    }

    // ── The model covers the table: every echo binding of a contract a production reader validates against has a mismatch
    // cell in the behavioural model, and every required one an unbound cell (or the contract's row is named below). ──

    // Bindings the behavioural model covers elsewhere (ListsSourceReviewR9FixTests: the MDBList records and the tmdb:N rows),
    // or contracts that are only rows of another's answer.
    private static readonly HashSet<string> CoveredElsewhere = new(StringComparer.Ordinal)
    {
        "tmdb movie row|Id", "tmdb movie row|MediaType", "tmdb tv row|Id", "tmdb tv row|MediaType", // tmdb:N legs (R9 AnAnswerToAnotherRequestIsNeverValid)
        "seerr movie row|Id", "seerr movie row|MediaType", "seerr tv row|Id", "seerr tv row|MediaType", // Seerr rows are read with no request (the page binds them)
        "tmdb search|SearchTmdbId", // TMDB's tmdb:N is read through the details legs, never a search
        "seerr search|SearchTmdbId", // ListsSourceReviewR10FixTests.AnExplicitIdSeerrSearchAnsweredWithAnotherId…
        "tmdb poster|Season", "tmdb poster|Show", // ListsSourceReviewR10FixTests.APosterAnswerWithoutTheIdentityAskedFor…
    };

    [Fact]
    public void TheBehaviouralModelCoversEveryEchoBinding()
    {
        List<(string Contract, string Fact, string Variant)> cells = ListsSourceReviewR10FixTests.KindCells.Select(c => (c.Contract, c.Fact, c.Variant))
            .Concat(ListsSourceReviewR10FixTests.SourceCells.Select(c => (c.Contract, c.Fact, c.Variant)))
            .Concat(new[] { ("mdblist record", "Id", "mismatch"), ("mdblist record", "Id", "unbound"), ("mdblist record", "MediaType", "mismatch"), ("mdblist record", "MediaType", "unbound"),
                ("mdblist batch row", "IdSet", "mismatch"), ("mdblist batch row", "IdSet", "unbound"), ("mdblist batch row", "MediaType", "mismatch"), ("mdblist batch row", "MediaType", "unbound") })
            .ToList();
        var missing = new List<string>();
        foreach (var contract in ResponseContract.All)
        {
            foreach (var (fact, binding) in contract.Bindings!.Where(b => b.Value.Kind == BindingKind.Echo))
            {
                var key = contract.Name + "|" + fact;
                if (CoveredElsewhere.Contains(key))
                {
                    continue;
                }

                if (!cells.Any(c => c.Contract == contract.Name && c.Fact == fact.ToString() && c.Variant.Contains("mismatch", StringComparison.Ordinal)))
                {
                    missing.Add(key + " mismatch");
                }

                if (binding.Paths.Any(p => p.Required) && !cells.Any(c => c.Contract == contract.Name && c.Fact == fact.ToString() && c.Variant == "unbound"))
                {
                    missing.Add(key + " unbound");
                }
            }
        }

        output.WriteLine(cells.Count + " model cells; missing: " + string.Join("; ", missing));
        Assert.Empty(missing);
    }

    // ── Diagnostics are codes: a sentinel in every value and member name never reaches a contract's Reason ──

    public static IEnumerable<object[]> ReasonCells() =>
        from contract in ResponseContract.All
        from planting in new[] { "values", "names", "extra members" }
        select new object[] { contract.Name, planting };

    [Theory]
    [MemberData(nameof(ReasonCells))]
    public void AContractsReasonNamesNoProviderText(string contractName, string planting)
    {
        var contract = Contract(contractName);
        var request = new AnswerRequest(Id: 10, MediaType: "movie", Season: 1, Show: 1412, Page: 1) { ListId = "7", Universe = "mcu", SearchTmdbId = 10, Ids = new[] { 10 } };
        var sample = "{\"id\":\"x\",\"page\":\"x\",\"type\":\"x\",\"title\":1,\"name\":1,\"season_number\":\"x\",\"seasonNumber\":\"x\",\"episodes\":[{\"x\":\"x\"},\"x\"],\"results\":[{\"id\":\"x\"},\"x\"],"
            + "\"ids\":{\"tmdb\":\"x\"},\"list\":{\"id\":\"x\"},\"props\":{\"pageProps\":{\"universe\":{\"id\":\"x\"}}},\"query\":{\"universe\":\"x\"},\"external_ids\":\"x\",\"externalIds\":\"x\",\"seasons\":[{\"x\":1}]}";
        using var doc = JsonDocument.Parse(ListsSourceReviewR10FixTests.Plant(sample, planting));
        var read = contract.Validate(request, doc.RootElement);
        output.WriteLine(contractName + " | " + planting + ": " + read.Verdict + " (" + read.Reason + ")");
        Assert.DoesNotContain("JEr10Sentinel", read.Reason ?? string.Empty, StringComparison.Ordinal);
    }

    // ── helpers ──

    private static (object Asked, JsonNode Value, JsonNode Other) Values(RequestFact fact) => fact switch
    {
        RequestFact.MediaType => ("movie", JsonValue.Create("movie"), JsonValue.Create("tv")),
        RequestFact.ListId => ("634", JsonValue.Create(634), JsonValue.Create(999)),
        RequestFact.Universe => ("mcu", JsonValue.Create("mcu"), JsonValue.Create("dctv")),
        RequestFact.SearchExternalId => ("tt1375666", JsonValue.Create("tt1375666"), JsonValue.Create("tt0133093")),
        RequestFact.IdSet => (new[] { 42, 43 }, JsonValue.Create(42), JsonValue.Create(77)),
        _ => (27205, JsonValue.Create(27205), JsonValue.Create(603)),
    };

    private static AnswerRequest Ask(RequestFact fact, object asked) => fact switch
    {
        RequestFact.Id => new AnswerRequest(Id: (int)asked),
        RequestFact.MediaType => new AnswerRequest(MediaType: (string)asked),
        RequestFact.Season => new AnswerRequest(Season: (int)asked),
        RequestFact.Show => new AnswerRequest(Show: (int)asked),
        RequestFact.Page => new AnswerRequest(Page: (int)asked),
        RequestFact.ListId => new AnswerRequest { ListId = (string)asked },
        RequestFact.Universe => new AnswerRequest { Universe = (string)asked },
        RequestFact.SearchTmdbId => new AnswerRequest { SearchTmdbId = (int)asked },
        RequestFact.SearchExternalId => new AnswerRequest { SearchExternalId = (string)asked },
        RequestFact.IdSet => new AnswerRequest { Ids = (int[])asked },
        _ => throw new ArgumentOutOfRangeException(nameof(fact)),
    };

    // Puts a value at a binding path, creating objects (and a one-row list for `rows[]`).
    private static void Put(JsonObject root, string path, JsonNode? value)
    {
        JsonObject node = root;
        var segments = path.Split('.');
        foreach (var segment in segments[..^1])
        {
            if (segment.EndsWith("[]", StringComparison.Ordinal))
            {
                var name = segment[..^2];
                if (node[name] is not JsonArray list)
                {
                    node[name] = list = new JsonArray(new JsonObject());
                }

                node = (JsonObject)list[0]!;
            }
            else
            {
                if (node[segment] is not JsonObject next)
                {
                    node[segment] = next = new JsonObject();
                }

                node = next;
            }
        }

        node[segments[^1]] = value;
    }
}
