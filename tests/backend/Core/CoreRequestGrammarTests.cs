using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace JE.Tests;

/// <summary>
/// The deterministic request grammars accept exactly what the regular expressions they replace accepted (the same
/// expressions, without a timeout, are the reference here), over valid, malformed and boundary corpora: every single-character
/// change, insertion and deletion of representative keys over ASCII and look-alike characters (other scripts' digits, the
/// dotted and dotless i, the long s, the Kelvin sign, spaces), and seeded random strings. One deliberate difference: a value
/// ending in a line feed (the expressions' "$" also matched before a final line feed) is refused (a title key is trimmed
/// first, as before).
/// </summary>
public class CoreRequestGrammarTests
{
    private static readonly char[] LookAlikes = new[] { 0x0130, 0x0131, 0x017F, 0x212A, 0x0660, 0x0661, 0x06F1, 0x0967, 0xFF10, 0xFF11, 0x00A0, 0x2028, 0x200B, 0x00E9 }
        .Select(c => (char)c).ToArray();
    private static readonly string DottedI = ((char)0x0130).ToString();
    private static readonly string Kelvin = ((char)0x212A).ToString();
    private static readonly string ArabicOne = ((char)0x0661).ToString();
    private static readonly string ArabicFour = ((char)0x0664).ToString();

    private static IEnumerable<char> Alphabet(bool lookAlikes = true)
        => Enumerable.Range(0, 128).Select(c => (char)c).Concat(lookAlikes ? LookAlikes : Array.Empty<char>());

    /// <summary>Every one-character substitution, insertion and deletion of each sample, plus seeded random strings.</summary>
    private static IEnumerable<string> Corpus(IEnumerable<string> samples, string randomAlphabet, int maxLength, int random = 20000, bool lookAlikes = true)
    {
        var alphabet = Alphabet(lookAlikes).ToArray();
        foreach (var sample in samples)
        {
            yield return sample;
            for (var i = 0; i <= sample.Length; i++)
            {
                if (i < sample.Length) yield return sample.Remove(i, 1);
                foreach (var c in alphabet)
                {
                    if (i < sample.Length) yield return sample[..i] + c + sample[(i + 1)..];
                    yield return sample.Insert(i, c.ToString());
                }
            }
        }
        var rng = new Random(20261021);
        for (var n = 0; n < random; n++)
        {
            var b = new StringBuilder();
            var length = rng.Next(0, maxLength + 1);
            for (var i = 0; i < length; i++) b.Append(randomAlphabet[rng.Next(randomAlphabet.Length)]);
            yield return b.ToString();
        }
    }

    private static void Same(IEnumerable<string> corpus, Func<string, object?> now, Func<string, object?> before, string what, bool lineFeedRefused = true)
    {
        var differ = new List<string>();
        var count = 0;
        foreach (var input in corpus)
        {
            count++;
            var expected = before(input);
            // The one deliberate difference: a trailing line feed is no longer part of a valid value.
            if (lineFeedRefused && input.EndsWith('\n') && expected is not (null or false))
            {
                if (now(input) is not (null or false)) differ.Add("accepted a trailing line feed: " + Show(input));
                continue;
            }
            var actual = now(input);
            if (!Equals(actual, expected) && differ.Count < 20) differ.Add(Show(input) + " -> " + (actual ?? "null") + ", was " + (expected ?? "null"));
        }
        Assert.True(count > 1000, what + ": corpus too small");
        Assert.True(differ.Count == 0, what + ": " + string.Join(" | ", differ));
    }

    private static string Show(string s) => "\"" + string.Concat(s.Select(c => c is >= ' ' and < (char)127 ? c.ToString() : "\\u" + ((int)c).ToString("X4", CultureInfo.InvariantCulture))) + "\"";

    // ------------------------------------------------------------------ references: the replaced expressions, untimed

    private static readonly Regex OldTitleKey = new(@"^(movie|tv):(tmdb|tvdb|imdb):(tt[0-9]{1,12}|[0-9]{1,12})(?::s([0-9]{1,4})(?::e([0-9]{1,5}))?)?$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    private static string? OldParse(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 64) return null;
        var m = OldTitleKey.Match(value.Trim());
        if (!m.Success) return null;
        var movie = m.Groups[1].Value.Equals("movie", StringComparison.OrdinalIgnoreCase);
        var provider = m.Groups[2].Value.ToLowerInvariant();
        var id = m.Groups[3].Value.ToLowerInvariant();
        var isImdb = id.StartsWith("tt", StringComparison.Ordinal);
        if (isImdb != (provider == "imdb")) return null;
        if (movie && (provider == "tvdb" || m.Groups[4].Success)) return null;
        int? season = m.Groups[4].Success ? int.Parse(m.Groups[4].Value, NumberStyles.None, CultureInfo.InvariantCulture) : null;
        int? episode = m.Groups[5].Success ? int.Parse(m.Groups[5].Value, NumberStyles.None, CultureInfo.InvariantCulture) : null;
        if (!isImdb) id = id.TrimStart('0') is { Length: > 0 } trimmed ? trimmed : "0";
        if (id == "0") return null;
        var s = (movie ? "movie:" : "tv:") + provider + ":" + id;
        if (season is int sn) s += ":s" + sn.ToString(CultureInfo.InvariantCulture);
        if (episode is int en) s += ":e" + en.ToString(CultureInfo.InvariantCulture);
        return s;
    }

    private static readonly Regex OldFeedKey = new(@"^(movie:tmdb:[1-9][0-9]{0,8}|tv:tvdb:[1-9][0-9]{0,8}(:s(0|[1-9][0-9]{0,3})(:e(0|[1-9][0-9]{0,4}))?)?)$", RegexOptions.CultureInvariant);
    private static readonly Regex OldTopic = new("^[A-Za-z0-9_-]{8,64}$", RegexOptions.CultureInvariant);
    private static readonly Regex OldDay = new("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", RegexOptions.None);
    private static readonly Regex OldImdb = new("^tt[0-9]{1,10}$", RegexOptions.CultureInvariant);

    private static (Regex, string)[] OldBranding()
    {
        var culture = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
            var opts = RegexOptions.IgnoreCase;
            return new[]
            {
                (new Regex(@"^icon-transparent\..*\.png$", opts), "icon-transparent.png"),
                (new Regex(@"^banner-light\..*\.png$", opts), "banner-light.png"),
                (new Regex(@"^banner-dark\..*\.png$", opts), "banner-dark.png"),
                (new Regex(@"^favicon\..*\.ico$", opts), "favicon.ico"),
                (new Regex(@"^touchicon\d*(\.[0-9a-f]+)?\.png$", opts), "apple-touch-icon.png"),
            };
        }
        finally { CultureInfo.CurrentCulture = culture; }
    }

    private static string? OldBrandingMatch((Regex, string)[] map, string? path)
    {
        if (string.IsNullOrEmpty(path) || path.IndexOf("/web/", StringComparison.OrdinalIgnoreCase) < 0) return null;
        var name = Path.GetFileName(path);
        if (string.IsNullOrEmpty(name)) return null;
        foreach (var (pattern, file) in map)
        {
            if (pattern.IsMatch(name)) return file;
        }
        return null;
    }

    // ------------------------------------------------------------------ conformance

    [Fact]
    public void TitleKeysParseAsTheirOldGrammarDid()
    {
        var samples = new[]
        {
            "movie:tmdb:603", "MOVIE:TMDB:0603", "movie:imdb:tt0133093", "tv:tvdb:78874", "tv:tmdb:1399:s1", "tv:imdb:tt0944947:s2:e10",
            "tv:tvdb:78874:s0:e0", "tv:tvdb:000078874:s0001:e00002", "tv:tvdb:123456789012:s9999:e99999", " movie:tmdb:1 ", "movie:tmdb:0",
            "tv:imdb:TT1:S1:E1", "movie:tvdb:1", "movie:tmdb:1:s1", "tv:tmdb:tt1", "tv:imdb:1",
        };
        Same(Corpus(samples, "movietvdbimsep:MTVDBSE0123456789 \n", 70), v => TitleKey.Parse(v)?.ToString(), OldParse, "TitleKey", lineFeedRefused: false);
    }

    [Fact]
    public void FeedKeysAreValidAsTheirOldGrammarSaid()
    {
        var samples = new[] { "movie:tmdb:603", "tv:tvdb:78874", "tv:tvdb:78874:s1", "tv:tvdb:78874:s0:e0", "tv:tvdb:999999999:s9999:e99999", "tv:tvdb:1:s01", "movie:tmdb:1:s1" };
        Same(Corpus(samples, "movietvdbsepa:0123456789\n", 52), v => ArrTitleKey.IsValid(v), v => v.Length <= ArrTitleKey.MaxLength && OldFeedKey.IsMatch(v), "ArrTitleKey");
        // The parse it gates: a trailing line feed once passed the shape check and then failed the number parse.
        Assert.False(ArrTitleKey.TryParse("tv:tvdb:78874:s1:e2\n", out _, out _, out _, out _));
        Assert.True(ArrTitleKey.TryParse("tv:tvdb:78874:s1:e2", out var type, out var id, out var season, out var episode) && type == "tv" && id == 78874 && season == 1 && episode == 2);
    }

    [Fact]
    public void TopicsAreValidAsTheirOldGrammarSaid()
    {
        var samples = new[] { "je-abcdefgh", "ABCDEFGH", "abcdefg", new string('a', 64), new string('a', 65), "abc_def-ghi" };
        Same(Corpus(samples, "aZ09_-./ \n", 70), v => NotifyEndpoints.IsTopic(v), v => OldTopic.IsMatch(v), "topic");
    }

    [Fact]
    public void CalendarDaysAndSeerrImdbIdsHaveTheirOldShape()
    {
        Same(Corpus(new[] { "2026-10-21", "0000-00-00", "2026-1-021" }, "0123456789-/ \n", 12), v => AsciiGrammar.IsDayShape(v), v => OldDay.IsMatch(v), "calendar day");
        Same(Corpus(new[] { "tt0133093", "tt1", "tt1234567890", "tt12345678901", "TT1" }, "tT0123456789 \n", 14), v => AsciiGrammar.IsImdb(v, 10), v => OldImdb.IsMatch(v), "Seerr IMDb id");
    }

    [Fact]
    public void BrandingNamesMatchAsTheirOldPatternsDid()
    {
        var map = OldBranding();
        var names = new[]
        {
            "icon-transparent.3f2a.png", "banner-light.a.png", "banner-dark..png", "banner-dark.png", "favicon.0f.ico", "favicon.ico",
            "touchicon.png", "touchicon144.png", "touchicon.3fA2.png", "touchicon72.ab12.png", "touchicon.png.png", "touchicon..png", "TOUCHICON512.PNG",
        };
        // The two non-ASCII letters the case-insensitive patterns took for i and k are checked on their own below (the
        // reference's answer for them depends on the culture's case tables).
        var corpus = Corpus(names.Select(n => "/web/" + n), "/webiconbaktrsnlhpgfv.-0123456789ABCDEF" + ArabicOne + "\n", 40, lookAlikes: false)
            .Concat(Corpus(names.Select(n => "/web/" + n), "x", 0, random: 0).Where(p => !p.Contains(DottedI, StringComparison.Ordinal) && !p.Contains(Kelvin, StringComparison.Ordinal)));
        Same(corpus, BrandingAssetStartupFilter.MatchBrandingAsset, p => OldBrandingMatch(map, p), "branding");
        Assert.Equal("icon-transparent.png", BrandingAssetStartupFilter.MatchBrandingAsset("/web/" + DottedI + "con-transparent.x.png"));
        Assert.Equal("banner-dark.png", BrandingAssetStartupFilter.MatchBrandingAsset("/web/banner-dar" + Kelvin + ".x.png"));
        Assert.Equal("apple-touch-icon.png", BrandingAssetStartupFilter.MatchBrandingAsset("/web/touchicon" + ArabicOne + ArabicFour + ".png"));
        Assert.Null(BrandingAssetStartupFilter.MatchBrandingAsset("/web/favicon.x.ico\n"));
    }
}
