using System.Runtime.CompilerServices;
using System.Text;
using System.Text.RegularExpressions;

namespace JE.Tests;

// Track 4c2a review rounds 2 and 3 (D53 rules 1 and 3, one transmission gate): a source scan that fails on any unnamed or raw
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
        foreach (var reserve in new[] { Body(code, "TryReserveListRequestAsync"), Body(code, "ReserveAsync") })
        {
            Assert.DoesNotMatch(@"CreateClient|GetAccountStatusAsync|GetAsync\s*\(|SendAsync\s*\(", reserve);
        }

        Assert.DoesNotMatch(@"\bvirtual\b[^;{]*(?:TryReserveListRequestAsync|ReserveAsync)", code); // tests use the real quota
    }

    // ── Review round 3 (D53 rule 3): the final check is the last step before the bytes leave ──

    [Fact]
    public void TheFinalCheckIsTheLastStepBeforeEverySendWithNoAwaitBetween()
    {
        var code = Code(Fetcher);
        foreach (var transport in new[] { "SendOnceAsync", "SeerrOnceAsync" })
        {
            var body = Body(code, transport);
            var sends = Regex.Matches(body, @"\.SendAsync\s*\(");
            Assert.NotEmpty(sends);
            foreach (Match send in sends)
            {
                var awaitSend = Regex.Matches(body[..send.Index], @"\bawait\b").Last();
                var gate = body.LastIndexOf("GateOpen(transmission)", awaitSend.Index, StringComparison.Ordinal);
                Assert.True(gate >= 0, transport + ": no final check before the send");
                Assert.DoesNotMatch(@"\bawait\b", body[gate..awaitSend.Index]); // nothing awaited between the check and the send
            }
        }

        // Every wait of the gate comes before the transport: the Seerr limiter's lease too.
        var gateBody = Body(code, "SendAsync");
        Assert.True(gateBody.IndexOf("_limiter.AcquireAsync", StringComparison.Ordinal) is var lease && lease >= 0 && lease < gateBody.IndexOf("SeerrOnceAsync(", StringComparison.Ordinal), "the limiter is awaited before the Seerr transport");
        Assert.DoesNotMatch(@"_limiter\.AcquireAsync", Body(code, "SeerrOnceAsync"));
    }

    [Fact]
    public void EveryAnswerTheGateReturnsIsStreamedThroughTheBoundedReader()
    {
        var code = Code(Fetcher);
        foreach (var transport in new[] { "SendOnceAsync", "SeerrOnceAsync" })
        {
            var body = Body(code, transport);
            foreach (Match send in Regex.Matches(body, @"\.SendAsync\s*\(([^;]*)\)\s*\.ConfigureAwait"))
            {
                Assert.Contains("HttpCompletionOption.ResponseHeadersRead", send.Groups[1].Value, StringComparison.Ordinal);
            }

            Assert.Contains("ReadBoundedAsync(response", body, StringComparison.Ordinal);
        }

        // The content of an answer is read nowhere else in the fetcher (no buffering reader, no helper that reads it whole).
        var outside = code.Replace(Body(code, "ReadBoundedAsync"), string.Empty, StringComparison.Ordinal);
        Assert.DoesNotMatch(@"ReadAsStringAsync|ReadAsByteArrayAsync|ReadAsStreamAsync|LoadIntoBufferAsync|ReadResponseAsync|ReadFromJsonAsync", outside);
    }

    [Fact]
    public void TheQuotaBalanceIsOnlyChargedAndReplacedByItsTwoHelpers()
    {
        var code = Code(File.ReadAllText(Path.Combine(Root(), "Services", "MdblistService.cs")));
        var hold = Body(code, "Hold");
        var consume = Body(code, "ConsumeLocked");
        var rest = code.Replace(hold, string.Empty, StringComparison.Ordinal).Replace(consume, string.Empty, StringComparison.Ordinal);

        // A status read replaces the balance only through Hold (requests charged since it was asked for come off it), and
        // a request is charged only through ConsumeLocked (which counts it).
        Assert.DoesNotMatch(@"_accountStatus\s*=[^=]", rest);
        Assert.DoesNotMatch(@"RateLimitRemaining\s*(?:=[^=>]|-=|--)", rest.Replace("RateLimitRemaining = GetNullableInt", string.Empty, StringComparison.Ordinal));
        var reserve = Body(code, "ReserveAsync");
        Assert.Matches(@"_statusRefresh\.WaitAsync", reserve); // one refresh at a time
        var locked = Body("private void L() " + reserve[reserve.LastIndexOf("lock (_accountStatusLock)", StringComparison.Ordinal)..], "L");
        Assert.Matches(@"FreshLocked\(\)[\s\S]*RateLimitRemaining\s*<=\s*Math\.Max\(SafetyMargin,[\s\S]*ConsumeLocked\(\)", locked); // checked and charged in one step
    }

    // ── Review round 4 (D53 rule 1 over its whole class): every send that spends the MDBList quota reserves first ──

    /// <summary>The start and length of the named method's body in blanked code (offsets match the raw source).</summary>
    private static (int Start, int Length) BodyAt(string code, string method)
    {
        var body = Body(code, method);
        var declaration = Regex.Match(code, @"(?:private|public|internal|protected)[^;{}=]*?\b" + Regex.Escape(method) + @"\s*(?:<[^>]*>)?\s*\(");
        return (code.IndexOf(body, declaration.Index, StringComparison.Ordinal), body.Length);
    }

    [Fact]
    public void EveryRequestThatSpendsTheMdblistQuotaReservesBeforeItIsSentAndIsChargedOnlyThere()
    {
        // Only two files talk to MDBList's API: its service (ratings, media batches, the status) and the list fetcher.
        var callers = Directory.EnumerateFiles(Root(), "*.cs", SearchOption.AllDirectories)
            .Select(f => Path.GetRelativePath(Root(), f).Replace('\\', '/'))
            .Where(f => !f.StartsWith("obj/", StringComparison.Ordinal) && !f.StartsWith("bin/", StringComparison.Ordinal))
            .Where(f => File.ReadAllText(Path.Combine(Root(), f)).Contains("api.mdblist.com", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(new[] { "Services/Acquire/Lists/Sources/ListSourceFetcher.cs", "Services/MdblistService.cs" }, callers);

        // MdblistService: every method that sends either reads the account status (/user, which isn't counted) or
        // reserves its request first, and a request is charged only inside the one reservation (never after a send).
        var raw = File.ReadAllText(Path.Combine(Root(), "Services", "MdblistService.cs"));
        var code = Code(raw);
        var methods = Regex.Matches(code, @"(?:private|public|internal|protected)\s+(?:static\s+)?(?:async\s+)?[\w<>\[\]?,\s]+?\s+(\w+)\s*\([^;{}]*\)\s*\{")
            .Select(m => m.Groups[1].Value).Distinct().ToList();
        var senders = 0;
        foreach (var method in methods)
        {
            var (start, length) = BodyAt(code, method);
            var body = code.Substring(start, length);
            var send = Regex.Match(body, @"\.(?:GetAsync|PostAsync|SendAsync|PutAsync)\s*\(");
            if (!send.Success)
            {
                continue;
            }

            senders++;
            if (raw.Substring(start, length).Contains("/user?apikey=", StringComparison.Ordinal))
            {
                Assert.Equal("ReadStatusAsync", method); // the status read alone, and nothing else is sent there
                Assert.Single(Regex.Matches(body, @"\.(?:GetAsync|PostAsync|SendAsync|PutAsync)\s*\("));
                continue;
            }

            var reserve = Regex.Match(body, @"if\s*\(\s*!\s*await\s+Reserve\w*Async\s*\(");
            Assert.True(reserve.Success && reserve.Index < send.Index, method + " sends to MDBList without reserving first");
        }

        Assert.Equal(3, senders); // the status read, the ratings lookup, the media batch
        var (reserveStart, reserveLength) = BodyAt(code, "ReserveAsync");
        foreach (Match charge in Regex.Matches(code, @"\bConsumeLocked\s*\(\s*\)\s*;"))
        {
            Assert.InRange(charge.Index, reserveStart, reserveStart + reserveLength);
        }

        // The fetcher: every api.mdblist.com request is a list read (which the gate reserves for) or the status read, and
        // the gate refuses an API read it can't reserve for (no quota means no read, never an unreserved one).
        var fetcherRaw = File.ReadAllText(Path.Combine(Lists, "Sources", "ListSourceFetcher.cs"));
        var transmissions = Regex.Matches(fetcherRaw, @"new\s+Transmission\(\s*(\w+)\s*,\s*""https://api\.mdblist\.com([^""]*)""");
        Assert.Equal(2, transmissions.Count);
        foreach (Match t in transmissions)
        {
            Assert.True(t.Groups[1].Value == "MdblistApiProvider" || (t.Groups[1].Value == "MdblistStatusProvider" && t.Groups[2].Value == "/user?apikey="), t.Value);
        }

        var gate = Body(Code(fetcherRaw), "SendAsync");
        Assert.Matches(@"Provider\s*==\s*MdblistApiProvider\s*&&\s*\(\s*_mdblist\s*==\s*null\s*\|\|\s*!\s*await\s+_mdblist\.TryReserveListRequestAsync", gate);
    }

    // ── Review round 3 (D53 rule 1): completeness is decided on the parsed rows ──

    [Fact]
    public void CompletenessIsOnlyDecidedOnTheRowsTheParsersReported()
    {
        var code = Code(Fetcher);

        // Pages and verdicts are made by SourceRead and SourceCompleteness only: a caller can't hand in a row count.
        Assert.DoesNotMatch(@"new\s+SourcePage\b|new\s+SourceVerdict\b|SourceVerdict\s*\(", code);

        // Every row parser answers with a SourceRow (usable, counted exclusion or malformed), never a bare entry.
        Assert.DoesNotMatch(@"static\s+SourceItem\?\s+\w+Item\s*\(", code);
        foreach (var parser in new[] { "TmdbRow", "SeerrRow", "TraktRow", "ImdbRow" })
        {
            Assert.Matches(@"static\s+SourceRow\s+" + parser + @"\s*\(", code);
            foreach (Match call in Regex.Matches(code, @"\b" + parser + @"\s*\("))
            {
                var before = code[Math.Max(0, call.Index - 40)..call.Index];
                Assert.True(Regex.IsMatch(before, @"(?:\.Row\(|static\s+SourceRow\s+)$") || code[call.Index..].StartsWith(parser + "(probeRow", StringComparison.Ordinal),
                    parser + " is reported into the read: " + code.Substring(Math.Max(0, call.Index - 40), 80));
            }
        }
    }

    [Fact]
    public void TheScannerSeesThroughStringsAndComments()
    {
        var code = Code("class A { private void M() { var s = \"{ CreateClient() }\"; // CreateClient()\n var c = '{'; X(); } private void N() { } }");
        Assert.DoesNotContain("CreateClient", code, StringComparison.Ordinal);
        Assert.Equal(" var s = \"" + new string(' ', 18) + "\"; " + new string(' ', 17) + "\n var c = ' '; X(); ", Body(code, "M"));
    }
}
