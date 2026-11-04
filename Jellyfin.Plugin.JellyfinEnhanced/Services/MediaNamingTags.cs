using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>Path-derived quality facts. Only these labels, never directory paths, leave the server.</summary>
internal sealed record MediaNamingTags(string? Source = null, string? Edition = null)
{
    private const RegexOptions Options = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;
    private const string Separator = @"[. _\-\[\]()]+";
    private const string OptionalSeparator = @"[. _\-\[\]()]*";
    private static readonly TimeSpan Timeout = TimeSpan.FromMilliseconds(100);
    /// <summary>Bare "WEB" needs a following quality token: the quality rules' resolutions and codecs, plus 1080i and x264/h.265 spellings.</summary>
    private static readonly string WebQualityTokens = string.Join("|", QualityTagRules.ResolutionTokens
        .Concat(QualityTagRules.CodecTokens).Select(Regex.Escape).Append("1080i").Append(@"[hx]" + OptionalSeparator + "26[45]"));
    private static Regex Token(string pattern) => new(@"(?:^|[. _\-\[\](){}])(?:" + pattern + @")(?=$|[. _\-\[\](){}])", Options, Timeout);
    private static readonly (Regex Pattern, string Label)[] Sources =
    [
        (Token(@"(?:bd" + OptionalSeparator + @")?remux|bdremux"), "REMUX"),
        (Token(@"blu" + OptionalSeparator + @"ray|b[dr]" + OptionalSeparator + @"rip"), "BluRay"),
        (Token(@"web" + OptionalSeparator + @"(?:dl|rip)|web(?=" + Separator + "(?:" + WebQualityTokens + @")(?:$|[. _\-\[\]()]))"), "WEB"),
        (Token("hdtv"), "HDTV"),
        (Token(@"dvd" + OptionalSeparator + "scr"), "SCR"),
        (Token(@"dvd(?:" + OptionalSeparator + @"rip)?"), "DVD"),
        (Token(@"(?:hd" + OptionalSeparator + @")?cam(?:rip)?"), "CAM"),
        (Token(@"(?:hd" + OptionalSeparator + @")?ts|telesync"), "TS"),
        (Token(@"tc|telecine"), "TC"),
        (Token(@"scr|screener|dvd" + OptionalSeparator + @"scr"), "SCR"),
    ];
    private static readonly Regex ExplicitEdition = new(@"\{edition-([^{}\r\n/\\]{1,64})\}", Options, Timeout);
    private static readonly Regex NonImax = Token(@"non" + OptionalSeparator + "imax");
    private static readonly (Regex Pattern, string Label)[] Editions =
    [
        (Token(@"director(?:['’]s|s)?" + Separator + @"cut"), "Director's Cut"),
        (Token(@"extended(?:" + Separator + @"(?:cut|edition))?"), "Extended"),
        (Token("unrated"), "Unrated"),
        (Token(@"theatrical(?:" + Separator + @"cut)?"), "Theatrical"),
        (Token(@"imax(?:" + Separator + @"enhanced)?"), "IMAX"),
        (Token("remaster(?:ed)?"), "Remastered"),
        (Token(@"criterion(?:" + Separator + @"collection)?"), "Criterion"),
        (Token("uncut"), "Uncut"),
        (Token(@"final" + Separator + @"cut"), "Final Cut"),
        (Token(@"special" + Separator + @"edition"), "Special Edition"),
    ];
    // Where the title ends: after the year in brackets ("(2019)"), else after the first year that
    // does not open the name ("2001 A Space Odyssey 1968"), and for an episode after its SxxEyy
    // marker and episode title (at the first '[' or quality token). Without a year or an episode
    // marker, a name only counts when it carries some release token. Known edition and source
    // words only count from there, so "Uncut Gems (2019)", "Uncut Gems.mkv", "The Final Cut
    // (2004)", "Cam (2018)", "Remux (2024)" or an episode called "The Director's Cut" carry none.
    private static readonly Regex BracketYearToken = new(@"[(\[](?:19|20)\d{2}[)\]]", Options, Timeout);
    private static readonly Regex YearToken = new(@"(?:^|[. _\-\[\](){}])(?:19|20)\d{2}(?=$|[. _\-\[\](){}])", Options, Timeout);
    private static readonly Regex EpisodeToken = new(@"(?:^|[. _\-\[\](){}])s\d{1,3}e\d{1,4}(?:-?e\d{1,4})*(?=$|[. _\-\[\](){}])", Options, Timeout);
    private static readonly Regex ReleaseBoundary = new(@"\[|" + Token(string.Join("|", QualityTagRules.ResolutionTokens.Concat(QualityTagRules.CodecTokens).Select(Regex.Escape)
        .Append(@"remux|bdremux|blu" + OptionalSeparator + @"ray|b[dr]" + OptionalSeparator + @"rip|web" + OptionalSeparator + @"(?:dl|rip)|web|hdtv|dvd(?:" + OptionalSeparator + @"rip)?|[hx]" + OptionalSeparator + "26[45]|1080i"))), Options, Timeout);
    private static readonly string[] ResolutionOrder = ["8K", "4K", "1440p", "1080p", "720p", "576p", "480p", "LOW-RES", "SD"];
    private static readonly string[] SourceOrder = ["REMUX", "BluRay", "WEB", "HDTV", "DVD", "SCR", "TC", "TS", "CAM"];

    /// <summary>Same resolution buckets as the quality renderer; source quality breaks equal-resolution ties.</summary>
    internal static MediaNamingTags Detect(string? itemPath, IReadOnlyList<MediaSourceInfo> sources, string? itemName = null)
    {
        var selected = sources.Select((source, index) => new
        {
            Tags = FromPath(string.IsNullOrWhiteSpace(source.Path) ? itemPath : source.Path, itemName),
            Resolution = source.MediaStreams?.Where(s => s.Type == MediaStreamType.Video)
                .Select(s => QualityTagRules.DetectResolution(new TagMediaStream { Height = s.Height, Width = s.Width, DisplayTitle = s.DisplayTitle }))
                .Select(label => Rank(ResolutionOrder, label)).DefaultIfEmpty(int.MaxValue).Min() ?? int.MaxValue,
            Index = index,
        }).OrderBy(s => s.Resolution).ThenBy(s => Rank(SourceOrder, s.Tags.Source)).ThenBy(s => s.Index).FirstOrDefault();
        var tags = selected?.Tags ?? FromPath(itemPath, itemName);
        // A physical stub takes precedence over release labels in any other version.
        var stub = new[] { itemPath }.Concat(sources.Select(s => s.Path)).FirstOrDefault(IsStub);
        return stub == null ? tags : tags with
        {
            Source = StubSource(string.Join(" | ", new[] { itemName, LocalNames(stub) }
                .Concat(sources.Where(s => string.Equals(s.Path, stub, StringComparison.OrdinalIgnoreCase)).Select(s => s.Name)))),
        };
    }

    /// <summary>Portable basename for the legacy filename signals sent to the client.</summary>
    internal static string? FileName(string? path) => string.IsNullOrEmpty(path) ? null : path.Replace('\\', '/').Split('/')[^1];

    private static int Rank(string[] order, string? label)
    {
        var rank = Array.IndexOf(order, label);
        return rank < 0 ? int.MaxValue : rank;
    }

    /// <summary>
    /// Detect a file first, then only its immediate parent (both Windows and Unix paths). With the
    /// item's own title, a name that starts with it is read from after the title, so its words
    /// ("Uncut Gems", "The Final Cut", "Cam") never become labels.
    /// </summary>
    internal static MediaNamingTags FromPath(string? path, string? itemName = null)
    {
        if (string.IsNullOrWhiteSpace(path)) return new();
        var parts = path.Replace('\\', '/').TrimEnd('/').Split('/');
        var file = parts[^1];
        var extension = System.IO.Path.GetExtension(file).ToLowerInvariant();
        if (extension is ".mkv" or ".mp4" or ".avi" or ".ts" or ".m2ts" or ".webm" or ".wmv" or ".mpg" or ".mpeg" or ".iso")
            file = file[..^extension.Length];
        var parent = parts.Length > 1 ? parts[^2] : string.Empty;
        var fileRest = WithoutTitle(file, itemName);
        var parentRest = WithoutTitle(parent, itemName);
        return new(IsStub(file) ? StubSource(file + " " + parent) : SourceIn(fileRest) ?? SourceIn(parentRest),
            EditionIn(file, requireMarker: true) ?? EditionIn(parent, requireMarker: true) ?? EditionIn(fileRest) ?? EditionIn(parentRest));
    }

    private static readonly Regex TitleWord = new(@"[\p{L}\p{N}]+", RegexOptions.CultureInvariant, Timeout);

    /// <summary>
    /// The name after a leading copy of the item's title (its words in order, any separators
    /// between them, case-insensitive), or the name itself when it does not start with the title.
    /// The remainder keeps a separator in front, so the year and release rules still see a boundary.
    /// </summary>
    internal static string WithoutTitle(string name, string? itemName)
    {
        if (string.IsNullOrWhiteSpace(itemName) || string.IsNullOrEmpty(name)) return name;
        var words = TitleWord.Matches(itemName).Select(m => Regex.Escape(m.Value)).ToArray();
        if (words.Length == 0) return name;
        var title = new Regex(@"^[^\p{L}\p{N}]*" + string.Join(@"[^\p{L}\p{N}]+", words) + @"(?![\p{L}\p{N}])", Options, Timeout).Match(name);
        return title.Success ? " " + name[title.Length..] : name;
    }

    private static bool IsStub(string? path) => path?.EndsWith(".disc", StringComparison.OrdinalIgnoreCase) == true;

    private static string? LocalNames(string? path) => path == null ? null : string.Join(' ', path.Replace('\\', '/').Split('/').TakeLast(2));

    private static string StubSource(string name)
    {
        var context = name.ToLowerInvariant();
        if (Regex.IsMatch(context, "bluray|blu-ray|bdrip|bd-rip|bdremux", Options, Timeout)) return "BluRay";
        if (Regex.IsMatch(context, "hddvd|hd-dvd|hd dvd", Options, Timeout)) return "HD DVD";
        if (context.Contains("dvd", StringComparison.Ordinal)) return "DVD";
        if (context.Contains("vhs", StringComparison.Ordinal)) return "VHS";
        if (context.Contains("hdtv", StringComparison.Ordinal)) return "HDTV";
        return "Physical";
    }

    private static string? SourceIn(string name)
    {
        var release = ReleasePart(name);
        return Sources.FirstOrDefault(rule => rule.Pattern.IsMatch(release)).Label;
    }

    /// <summary>The part of a file or folder name after its title (see <see cref="YearToken"/>); the whole name when no boundary is known.</summary>
    internal static string ReleasePart(string name)
    {
        var part = name;
        var bracketYear = BracketYearToken.Match(part);
        var year = bracketYear.Success ? bracketYear : YearToken.Matches(part).FirstOrDefault(m => m.Index > 0);
        if (year != null) part = part[(year.Index + year.Length)..];
        var episode = EpisodeToken.Match(part);
        if (year == null && !episode.Success) return ReleaseBoundary.IsMatch(part) ? part : string.Empty;
        if (episode.Success)
        {
            var rest = part[(episode.Index + episode.Length)..];
            var boundary = ReleaseBoundary.Match(rest);
            part = boundary.Success ? rest[boundary.Index..] : string.Empty;
        }

        return part;
    }

    private static string? EditionIn(string name, bool requireMarker = false)
    {
        var explicitTag = ExplicitEdition.Match(name);
        if (requireMarker && !explicitTag.Success) return null;
        var value = explicitTag.Success ? explicitTag.Groups[1].Value.Trim() : ReleasePart(name);
        // Explicit custom labels are bounded, plain text and never accept path separators or controls.
        var nonImax = NonImax.IsMatch(value);
        var known = Editions.FirstOrDefault(rule => (rule.Label != "IMAX" || !nonImax) && rule.Pattern.IsMatch(value)).Label;
        if (known != null) return known;
        return explicitTag.Success && value.Length > 0 && !value.Any(char.IsControl) ? value : null;
    }
}
