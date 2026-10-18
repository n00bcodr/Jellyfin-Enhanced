using System.Runtime.CompilerServices;
using System.Text;
using System.Text.RegularExpressions;

namespace JE.Tests;

// Track 4c2a review round 2 (D53 rule 3, one transmission gate): a source scan that fails on any unnamed or raw
// HttpClient use in Services/Acquire/Lists/**, and on any list-source transmission that doesn't pass the fetcher's one
// gate (SendAsync: the provider switch re-checked, admission and quota charged, then the source transport). The shared
// MdblistService path the gate calls for the quota (TryReserveListRequestAsync) must not reach its own unnamed client.
// The behaviour itself is proven by ListsImportReviewR2FixTests (the real production paths); this guards the structure
// against a new bypass.
public class ListsSourceTransmissionScanTests
{
    private static string Root([CallerFilePath] string caller = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(caller)!, "..", "..", "..", "..", "Jellyfin.Plugin.JellyfinEnhanced"));

    private static string Lists => Path.Combine(Root(), "Services", "Acquire", "Lists");

    private static string Fetcher => File.ReadAllText(Path.Combine(Lists, "Sources", "ListSourceFetcher.cs"));

    /// <summary>The source with comments, string and char literals blanked (same length, so offsets stay valid).</summary>
    internal static string Code(string source)
    {
        var code = new StringBuilder(source);
        for (var i = 0; i < source.Length; i++)
        {
            if (source[i] == '/' && i + 1 < source.Length && source[i + 1] == '/')
            {
                while (i < source.Length && source[i] != '\n')
                {
                    code[i++] = ' ';
                }
            }
            else if (source[i] == '/' && i + 1 < source.Length && source[i + 1] == '*')
            {
                var end = source.IndexOf("*/", i + 2, StringComparison.Ordinal);
                end = end < 0 ? source.Length : end + 2;
                for (; i < end; i++)
                {
                    code[i] = source[i] == '\n' ? '\n' : ' ';
                }

                i--;
            }
            else if (source[i] == '"')
            {
                var verbatim = i > 0 && (source[i - 1] == '@' || (source[i - 1] == '$' && i > 1 && source[i - 2] == '@'));
                var j = i + 1;
                while (j < source.Length)
                {
                    if (!verbatim && source[j] == '\\')
                    {
                        j += 2;
                        continue;
                    }

                    if (source[j] == '"')
                    {
                        if (verbatim && j + 1 < source.Length && source[j + 1] == '"')
                        {
                            j += 2;
                            continue;
                        }

                        break;
                    }

                    j++;
                }

                for (var k = i + 1; k < j && k < source.Length; k++)
                {
                    code[k] = ' ';
                }

                i = j;
            }
            else if (source[i] == '\'' && i + 2 < source.Length)
            {
                var end = source[i + 1] == '\\' ? source.IndexOf('\'', i + 3) : i + 2;
                for (var k = i + 1; k < end; k++)
                {
                    code[k] = ' ';
                }

                i = end;
            }
        }

        return code.ToString();
    }

    /// <summary>The body (between its braces) of the named method declaration in blanked code.</summary>
    internal static string Body(string code, string method)
    {
        var declaration = Regex.Match(code, @"(?:private|public|internal|protected)[^;{}=]*?\b" + Regex.Escape(method) + @"\s*(?:<[^>]*>)?\s*\(");
        Assert.True(declaration.Success, method + " is declared");
        var open = code.IndexOf('{', declaration.Index + declaration.Length);
        var depth = 0;
        for (var i = open; i < code.Length; i++)
        {
            depth += code[i] == '{' ? 1 : code[i] == '}' ? -1 : 0;
            if (depth == 0)
            {
                return code.Substring(open + 1, i - open - 1);
            }
        }

        throw new InvalidOperationException("unbalanced " + method);
    }

    private static IEnumerable<(string File, string Code)> ListsFiles() =>
        Directory.EnumerateFiles(Lists, "*.cs", SearchOption.AllDirectories).Select(f => (Path.GetRelativePath(Root(), f), Code(File.ReadAllText(f))));

    [Fact]
    public void NoUnnamedOrRawHttpClientInTheListsSubsystem()
    {
        var offences = new List<string>();
        foreach (var (file, code) in ListsFiles())
        {
            foreach (Match m in Regex.Matches(code, @"new\s+HttpClient\s*\(|new\s+(?:HttpClientHandler|SocketsHttpHandler)\b|\.CreateClient\s*\(\s*\)|HttpClient\.(?:GetAsync|SendAsync)"))
            {
                if (!(file.EndsWith("SourceHttp.cs", StringComparison.Ordinal) && m.Value.Contains("SocketsHttpHandler", StringComparison.Ordinal)))
                {
                    offences.Add(file + ": " + m.Value);
                }
            }

            // Every named client is the source transport or Seerr's own no-redirect client (the administrator's Seerr).
            foreach (Match m in Regex.Matches(code, @"CreateClient\s*\(([^()]*)\)"))
            {
                var name = m.Groups[1].Value.Trim();
                if (name != "SourceHttp.ClientName" && name != "_httpClientFactory" && name != "SeerrHttpHelper.NamedClient")
                {
                    offences.Add(file + ": CreateClient(" + name + ")");
                }
            }
        }

        Assert.Empty(offences);
    }

    [Fact]
    public void ListSourcesNeverUseAClientThatCanFallBackToTheUnnamedOneOrTheTmdbCache()
    {
        foreach (var file in Directory.EnumerateFiles(Path.Combine(Lists, "Sources"), "*.cs"))
        {
            var code = Code(File.ReadAllText(file));
            Assert.DoesNotMatch(@"SeerrHttpHelper\.CreateClient\s*\(", code); // falls back to the unnamed client
            Assert.DoesNotMatch(@"_tmdb\s*\.\s*GetAsync|TmdbResponseCache\s*\.\s*GetAsync", code); // its default client follows redirects
        }
    }

    [Fact]
    public void EveryListSourceTransmissionPassesTheOneGate()
    {
        var code = Code(Fetcher);
        var gate = Body(code, "SendAsync");
        var transports = new[] { "SendOnceAsync", "SeerrOnceAsync" };

        // The gate re-checks the switch, charges admission and the quota, then hands the request to a transport.
        Assert.Matches(@"\bGateOpen\s*\(", gate);
        Assert.Matches(@"\bAdmit\s*\(", gate);
        Assert.Matches(@"\bTryReserveListRequestAsync\s*\(", gate);
        foreach (var transport in transports)
        {
            Assert.Matches(@"\b" + transport + @"\s*\(", gate);
        }

        // A client is created and sent on only inside the transports, and the transports are called only by the gate.
        var outside = code;
        foreach (var method in transports.Append("SendAsync"))
        {
            outside = outside.Replace(Body(code, method), string.Empty, StringComparison.Ordinal);
        }

        Assert.DoesNotMatch(@"CreateClient\s*\(", outside);
        Assert.DoesNotMatch(@"\.SendAsync\s*\(\s*request", outside);
        foreach (var transport in transports)
        {
            Assert.DoesNotMatch(@"\b" + transport + @"\s*\(", Regex.Replace(outside, @"(?:private|public|internal)[^;{}=]*?\b" + transport + @"\s*\(", string.Empty));
        }

        // The transports use the source transport and Seerr's named no-redirect client, nothing else.
        Assert.Contains("CreateClient(SourceHttp.ClientName)", Body(code, "SendOnceAsync"), StringComparison.Ordinal);
        Assert.Contains("CreateClient(SeerrHttpHelper.NamedClient)", Body(code, "SeerrOnceAsync"), StringComparison.Ordinal);
    }

    [Fact]
    public void TheQuotaReservationNeverReadsTheAccountStatusItself()
    {
        var code = Code(File.ReadAllText(Path.Combine(Root(), "Services", "MdblistService.cs")));
        var reserve = Body(code, "TryReserveListRequestAsync");

        Assert.DoesNotMatch(@"CreateClient|GetAccountStatusAsync|GetAsync\s*\(|SendAsync\s*\(", reserve);
        Assert.DoesNotMatch(@"\bvirtual\b[^;{]*TryReserveListRequestAsync", code); // tests use the real quota
    }

    [Fact]
    public void TheScannerSeesThroughStringsAndComments()
    {
        var code = Code("class A { private void M() { var s = \"{ CreateClient() }\"; // CreateClient()\n var c = '{'; X(); } private void N() { } }");
        Assert.DoesNotContain("CreateClient", code, StringComparison.Ordinal);
        Assert.Equal(" var s = \"" + new string(' ', 18) + "\"; " + new string(' ', 17) + "\n var c = ' '; X(); ", Body(code, "M"));
    }
}
