using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using L = JE.Tests.IntegrationRequestLedgerTests;

namespace JE.Tests;

/// <summary>
/// A valid request is parsed the same however long the server takes to schedule it: no request grammar may depend on a
/// wall-clock match timeout (a valid <c>movie:tmdb:603</c> failed with a regex timeout under a loaded test run).
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationRequestGrammarTests
{
    /// <summary>
    /// Pauses every regular expression the plugin keeps in a static field inside its own matching, after its match timeout
    /// started (the scheduling pause a loaded server gives it), then restores them. Same pattern, same timeout, same input.
    /// </summary>
    internal sealed class RegexPause : IDisposable
    {
        private static readonly FieldInfo Factory = typeof(Regex).GetField("factory", BindingFlags.Instance | BindingFlags.NonPublic)!;
        private static readonly FieldInfo Runner = typeof(Regex).GetField("_runner", BindingFlags.Instance | BindingFlags.NonPublic)!;
        private readonly List<(Regex Regex, object? Factory, object? Runner)> _held = new();

        public RegexPause(int milliseconds = 150)
        {
            foreach (var regex in StaticRegexes())
            {
                _held.Add((regex, Factory.GetValue(regex), Runner.GetValue(regex)));
                Factory.SetValue(regex, new PausedFactory((RegexRunnerFactory)Factory.GetValue(regex)!, milliseconds));
                Runner.SetValue(regex, null);
            }
        }

        /// <summary>How many expressions are paused, and how many of them have a match timeout.</summary>
        public int Count => _held.Count;

        public IReadOnlyList<Regex> Timed => _held.Select(h => h.Regex).Where(r => r.MatchTimeout != Regex.InfiniteMatchTimeout).ToList();

        public void Dispose()
        {
            foreach (var (regex, factory, runner) in _held)
            {
                Factory.SetValue(regex, factory);
                Runner.SetValue(regex, runner);
            }
        }

        /// <summary>Every regular expression held in a static field of the plugin (alone, in an array, or in an array of tuples).</summary>
        internal static IReadOnlyList<Regex> StaticRegexes()
        {
            var found = new List<Regex>();
            void Add(object? value)
            {
                switch (value)
                {
                    case Regex regex when !found.Contains(regex): found.Add(regex); break;
                    case ITuple tuple: for (var i = 0; i < tuple.Length; i++) Add(tuple[i]); break;
                    case Array array: foreach (var item in array) Add(item); break;
                }
            }
            Type?[] types;
            try { types = typeof(TitleKey).Assembly.GetTypes(); }
            catch (ReflectionTypeLoadException ex) { types = ex.Types; }
            foreach (var type in types.OfType<Type>().Where(t => !t.ContainsGenericParameters))
            {
                foreach (var field in type.GetFields(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
                {
                    if (field.IsLiteral || !(field.FieldType == typeof(Regex) || field.FieldType.IsArray)) continue;
                    try { Add(field.GetValue(null)); }
                    catch (TargetInvocationException) { }
                    catch (TypeInitializationException) { }
                }
            }
            return found;
        }
    }

    private sealed class PausedFactory(RegexRunnerFactory original, int milliseconds) : RegexRunnerFactory
    {
        protected override RegexRunner CreateInstance()
        {
            var create = typeof(RegexRunnerFactory).GetMethod("CreateInstance", BindingFlags.Instance | BindingFlags.NonPublic)!;
            return new PausedRunner((RegexRunner)create.Invoke(original, null)!, milliseconds);
        }
    }

    private sealed class PausedRunner : RegexRunner
    {
        private delegate void ScanCall(ReadOnlySpan<char> text);
        private static readonly FieldInfo[] Fields = typeof(RegexRunner).GetFields(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
        private readonly RegexRunner _inner;
        private readonly ScanCall _scan;
        private readonly int _milliseconds;

        public PausedRunner(RegexRunner original, int milliseconds)
        {
            _inner = original;
            _milliseconds = milliseconds;
            _scan = original.GetType().GetMethod("Scan", BindingFlags.Instance | BindingFlags.NonPublic, new[] { typeof(ReadOnlySpan<char>) })!.CreateDelegate<ScanCall>(original);
        }

        protected override void Scan(ReadOnlySpan<char> text)
        {
            Thread.Sleep(_milliseconds);
            foreach (var field in Fields) field.SetValue(_inner, field.GetValue(this));
            try { _scan(text); }
            finally { foreach (var field in Fields) field.SetValue(this, field.GetValue(_inner)); }
        }
    }

    private static string? Branding(string path)
        => (string?)typeof(BrandingAssetStartupFilter).GetMethod("MatchBrandingAsset", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public)!.Invoke(null, new object?[] { path });

    // The original suite failure: a valid bounded movie request, normalized while the server pauses the request (here inside
    // every regular expression the plugin holds, after its timeout started, and once more while the request is prepared).
    [Fact]
    public async Task AValidRequestIsNormalizedWhateverTheSchedulingPause()
    {
        using var r = new L.Rig();
        var paused = 0;
        r.Policy.Before = (_, _) => { Interlocked.Increment(ref paused); Thread.Sleep(150); return Task.CompletedTask; };
        RequestOutcome? outcome;
        Exception? exception;
        using (new RegexPause())
        {
            outcome = null;
            exception = await Record.ExceptionAsync(async () => outcome = await r.Create(input: L.Movie(603)));
        }
        Assert.True(exception == null, $"Valid movie:tmdb:603 escaped instead of an outcome: {exception}");
        Assert.True(paused > 0, "the request was paused while it was worked on");
        Assert.Equal(201, outcome!.HttpStatus);
        // Normalization ran: the ledger keyed the ask by the parsed title.
        Assert.Equal("movie:tmdb:603", Assert.Single(r.Ledger.ForTitle("movie:tmdb:603")).Input.Key);
    }

    // Each request-path grammar accepts its valid input under the same pause (title keys, feed keys, ntfy topics, the five
    // branding names); a timed expression throws there or (branding) falls back to the stock image.
    [Theory]
    [InlineData("title-key")]
    [InlineData("feed-key")]
    [InlineData("topic")]
    [InlineData("branding-icon")]
    [InlineData("branding-banner-light")]
    [InlineData("branding-banner-dark")]
    [InlineData("branding-favicon")]
    [InlineData("branding-touchicon")]
    public void EveryRequestGrammarAcceptsItsValidInputWhateverTheSchedulingPause(string grammar)
    {
        using var pause = new RegexPause();
        var result = Record.Exception(() =>
        {
            switch (grammar)
            {
                case "title-key": Assert.Equal("tv:tvdb:78874:s1:e2", TitleKey.Parse("TV:TVDB:078874:s1:e2")?.ToString()); break;
                case "feed-key":
                    Assert.True(ArrTitleKey.IsValid("tv:tvdb:78874:s1:e2"));
                    Assert.True(ArrTitleKey.IsFeedKey("movie:tmdb:603"));
                    Assert.Equal("tv:tvdb:78874", ArrTitleKey.TitleOf("tv:tvdb:78874:s0:e0"));
                    break;
                case "topic": Assert.True(NotifyEndpoints.IsTopic("je-abc_DEF-123")); break;
                case "branding-icon": Assert.Equal("icon-transparent.png", Branding("/web/icon-transparent.3f2a.png")); break;
                case "branding-banner-light": Assert.Equal("banner-light.png", Branding("/web/banner-light.3f2a.png")); break;
                case "branding-banner-dark": Assert.Equal("banner-dark.png", Branding("/web/banner-dark.3f2a.png")); break;
                case "branding-favicon": Assert.Equal("favicon.ico", Branding("/web/favicon.3f2a.ico")); break;
                case "branding-touchicon": Assert.Equal("apple-touch-icon.png", Branding("/web/favicons/touchicon144.png")); break;
            }
        });
        Assert.True(result == null, $"{grammar} under a scheduling pause: {result}");
    }

    // No expression the plugin holds has a match timeout (the enumerating half of the scan below).
    [Fact]
    public void NoHeldExpressionHasAMatchTimeout()
    {
        var timed = RegexPause.StaticRegexes().Where(r => r.MatchTimeout != Regex.InfiniteMatchTimeout).Select(r => r.ToString()).ToList();
        Assert.True(timed.Count == 0, "timed expressions held: " + string.Join(" | ", timed));
    }

    // Every production source file: no regular expression is built or matched with a match timeout (a static
    // Regex.IsMatch/Match/Replace/Split call with a TimeSpan, or a Regex built with one), request path or background.
    [Fact]
    public void NoProductionCodeMatchesWithATimeout()
    {
        var timed = TimedRegexSites();
        Assert.True(timed.Count == 0, "timed regular expressions: " + string.Join(", ", timed));
    }

    /// <summary>Each production call that builds or runs a regular expression with a match timeout, as file:line.</summary>
    internal static List<string> TimedRegexSites([CallerFilePath] string self = "")
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(self)!);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "Jellyfin.Plugin.JellyfinEnhanced", "Services"))) dir = dir.Parent;
        Assert.NotNull(dir);
        var root = Path.Combine(dir!.FullName, "Jellyfin.Plugin.JellyfinEnhanced");
        var timed = new List<string>();
        var call = new Regex(@"new\s+(System\.Text\.RegularExpressions\.)?Regex\s*\(|Regex\.(IsMatch|Match|Matches|Replace|Split|EnumerateMatches|Count)\s*\(|new\s*\(\s*@?""", RegexOptions.CultureInvariant);
        var sep = Path.DirectorySeparatorChar;
        foreach (var file in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories).Where(f => !f.Contains(sep + "obj" + sep) && !f.Contains(sep + "bin" + sep)))
        {
            var text = File.ReadAllText(file);
            foreach (Match m in call.Matches(text))
            {
                var open = text.IndexOf('(', m.Index);
                var args = Arguments(text, open);
                // A target-typed new(...) counts only when it builds an expression (its arguments name RegexOptions).
                if (m.Value.StartsWith("new", StringComparison.Ordinal) && !m.Value.Contains("Regex", StringComparison.Ordinal) && !args.Contains("RegexOptions", StringComparison.Ordinal)) continue;
                if (args.Contains("TimeSpan", StringComparison.Ordinal) || args.Contains("MatchTimeout", StringComparison.Ordinal))
                    timed.Add(Path.GetRelativePath(root, file) + ":" + (text[..m.Index].Count(c => c == '\n') + 1));
            }
        }
        return timed;
    }

    // The text of a call's arguments: from its '(' to the matching ')', string and character literals skipped whole.
    private static string Arguments(string text, int open)
    {
        var depth = 0;
        for (var i = open; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '@' && i + 1 < text.Length && text[i + 1] == '"')
            {
                for (i += 2; i < text.Length; i++)
                {
                    if (text[i] != '"') continue;
                    if (i + 1 < text.Length && text[i + 1] == '"') { i++; continue; }
                    break;
                }
                continue;
            }
            if (c is '"' or '\'')
            {
                for (i++; i < text.Length && text[i] != c; i++)
                {
                    if (text[i] == '\\') i++;
                }
                continue;
            }
            if (c == '(') depth++;
            else if (c == ')' && --depth == 0) return text[open..(i + 1)];
        }
        return text[open..];
    }
}
