// Harness for the native poster tag renderer (issue #590). Not shipped; see PosterTagsHarness.csproj.
//
//   dotnet run -c Release -p:Skia=3.119.4 -- <command> [options]
//
// Commands:
//   parity   --artifacts DIR --out DIR   Reproduce the real jellyfin-web captures (proof/corners): tag rects and pixels.
//   contact  --out DIR                   Contact sheet: every quality colour, genre icon, ~20 flags, rating chips and
//                                         age-rating samples at 180 and 290 logical width.
//   samples  --out DIR                   Full layouts on synthetic posters/thumbs at real output sizes.
//   bench    [--seconds N]               ms/poster at 266x399 and 600x900, 1 and 4 threads, cold and warm tile cache.
//   stress   [--rounds N]                Concurrent renders must equal sequential ones; RSS over N x 20000 renders.
//   assets                               Decode every embedded flag, report font/HarfBuzz status.
//   all      --artifacts DIR --out DIR   Everything above.
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using SkiaSharp;

namespace PosterTagsHarness;

internal static class Program
{
    private static readonly string SkiaLine = typeof(Program).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
        .FirstOrDefault(a => a.Key == "Skia")?.Value ?? "?";

    private static int Main(string[] args)
    {
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
        if (args.Length == 0)
        {
            Console.WriteLine("usage: <parity|contact|samples|bench|stress|assets|all> [--artifacts DIR] [--out DIR] [--seconds N]");
            return 2;
        }

        var opts = ParseOptions(args.Skip(1).ToArray());
        string outDir = Path.GetFullPath(opts.GetValueOrDefault("out", Path.Combine(Path.GetTempPath(), "poster-tags-harness")));
        string artifacts = opts.GetValueOrDefault("artifacts", string.Empty);
        double seconds = double.Parse(opts.GetValueOrDefault("seconds", "3"), CultureInfo.InvariantCulture);
        Directory.CreateDirectory(outDir);

        Console.WriteLine($"SkiaSharp {typeof(SKCanvas).Assembly.GetName().Version} (native {SkiaSharpVersion.Native}), " +
                          $"HarfBuzzSharp {typeof(HarfBuzzSharp.Blob).Assembly.GetName().Version}, harness line {SkiaLine}, " +
                          $".NET {Environment.Version}, {Environment.ProcessorCount} CPUs");

        int rc = 0;
        switch (args[0])
        {
            case "parity": rc = Parity.Run(artifacts, outDir); break;
            case "contact": ContactSheet.Run(outDir); break;
            case "samples": Samples.Run(outDir); break;
            case "bench": Bench.Run(seconds); break;
            case "stress": rc = Stress.Run(int.Parse(opts.GetValueOrDefault("rounds", "1"), CultureInfo.InvariantCulture)); break;
            case "assets": rc = AssetCheck.Run(); break;
            case "all":
                rc |= AssetCheck.Run();
                rc |= Parity.Run(artifacts, outDir);
                ContactSheet.Run(outDir);
                Samples.Run(outDir);
                rc |= Stress.Run();
                Bench.Run(seconds);
                break;
            default:
                Console.WriteLine($"unknown command {args[0]}");
                return 2;
        }

        return rc;
    }

    private static Dictionary<string, string> ParseOptions(string[] args)
    {
        var d = new Dictionary<string, string>();
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i].StartsWith("--", StringComparison.Ordinal) && i + 1 < args.Length)
            {
                d[args[i][2..]] = args[++i];
            }
        }

        return d;
    }

    internal static void SavePng(SKBitmap bitmap, string path)
    {
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        File.WriteAllBytes(path, data.ToArray());
        Console.WriteLine($"  wrote {path}");
    }

    internal static SKBitmap LoadPng(string path)
    {
        using var data = SKData.Create(path) ?? throw new FileNotFoundException(path);
        using var codec = SKCodec.Create(data) ?? throw new InvalidDataException(path);
        var info = new SKImageInfo(codec.Info.Width, codec.Info.Height, SKColorType.Rgba8888, SKAlphaType.Premul);
        return SKBitmap.Decode(codec, info) ?? throw new InvalidDataException(path);
    }

    internal static SKBitmap Convert(SKBitmap source)
    {
        var result = new SKBitmap(new SKImageInfo(source.Width, source.Height, SKColorType.Rgba8888, SKAlphaType.Premul));
        using var canvas = new SKCanvas(result);
        canvas.DrawBitmap(source, 0, 0);
        return result;
    }
}

/// <summary>Synthetic test content (posters, layouts).</summary>
internal static class Fixtures
{
    public static readonly string[] QualityLabels =
    {
        "8K", "4K", "1440p", "1080p", "720p", "576p", "480p", "LOW-RES", "SD",
        "BluRay", "HD DVD", "DVD", "VHS", "HDTV", "Physical",
        "Dolby Vision", "HDR10+", "HDR10", "HDR", "IMAX", "3D",
        "AV1", "HEVC", "H265", "VP9", "H264", "VP8", "XVID", "DIVX", "WMV", "MPEG2", "MPEG4", "MJPEG", "THEORA",
        "ATMOS", "DTS-X", "TRUEHD", "DTS", "Dolby Digital+", "7.1", "5.1",
        "ATMOS 7.1", "DTS 5.1", "Dolby Digital+ 5.1", "TRUEHD 7.1", "DTS-X 7.1",
    };

    public static readonly string[] GenreIcons =
    {
        "animation", "article", "auto_awesome", "domino_mask", "explore", "family_restroom", "favorite", "history_edu",
        "landscape", "live_tv", "local_police", "menu_book", "military_tech", "mood", "music_note", "music_video",
        "psychology", "psychology_alt", "quiz", "science", "skull", "sports_martial_arts", "sports_soccer",
        "theater_comedy", "theaters", "tv", "unknown_icon_falls_back",
    };

    public static readonly string[] Flags =
    {
        "gb", "us", "jp", "es", "mx", "fr", "de", "it", "kr", "cn", "tw", "ru", "br", "pt", "in", "sa", "se", "no",
        "es-ct", "es-ga", "es-pv", "ua", "il", "zxx",
    };

    public static readonly (string Text, string Key)[] AgeRatings =
    {
        ("G", "G"), ("PG", "PG"), ("PG-13", "PG-13"), ("R", "R"), ("NC-17", "NC-17"), ("TV-MA", "TV-MA"),
        ("TV-Y7-FV", "TV-Y7-FV"), ("16", "16"), ("AU-M", "AU-M"), ("R18+", "R18+"), ("IN-S", "IN-S"), ("NR", "NR"),
        ("FSK-0", "FSK-0"), ("FSK-6", "FSK-6"), ("FSK-12", "FSK-12"), ("FSK-16", "FSK-16"), ("FSK-18", "FSK-18"),
        ("SE-Btl", "SE-Btl"), ("Unknown 9", "Unknown 9"),
    };

    public static string Category(string label) => label switch
    {
        "8K" or "4K" or "1440p" or "1080p" or "720p" or "576p" or "480p" or "LOW-RES" or "SD" => "resolution",
        "BluRay" or "HD DVD" or "DVD" or "VHS" or "HDTV" or "Physical" => "source",
        "Dolby Vision" or "HDR10+" or "HDR10" or "HDR" => "dynamicRange",
        "IMAX" or "3D" => "specialFormat",
        "AV1" or "HEVC" or "H265" or "VP9" or "H264" or "VP8" or "XVID" or "DIVX" or "WMV" or "MPEG2" or "MPEG4" or "MJPEG" or "THEORA" => "videoCodec",
        _ => "audioInfo",
    };

    public static PosterTagLayout Full(bool landscape, bool offset = false)
    {
        return new PosterTagLayout(new List<PosterTagGroupLayout>
        {
            new(PosterTagGroup.Quality, PosterTagCorner.TopLeft, new PosterTag[] { Q("4K"), Q("Dolby Vision"), Q("HEVC"), Q("ATMOS 7.1") }),
            new(PosterTagGroup.Genre, PosterTagCorner.TopRight, new PosterTag[] { new GenreTag("Science Fiction", "science"), new GenreTag("Adventure", "explore"), new GenreTag("Drama", "theater_comedy") }),
            new(PosterTagGroup.Rating, PosterTagCorner.BottomRight, new PosterTag[] { new RatingTag(PosterRatingSource.Critic, "91%", true), new RatingTag(PosterRatingSource.Community, "8.4", false), new RatingTag(PosterRatingSource.UserReview, "7.5", false) }),
            new(PosterTagGroup.AgeRating, PosterTagCorner.BottomRight, new PosterTag[] { new AgeRatingTag("PG-13", "PG-13") }),
            new(PosterTagGroup.Language, PosterTagCorner.BottomLeft, new PosterTag[] { new LanguageTag("gb", "English", false), new LanguageTag("jp", "Japanese", false), new LanguageTag("es-ct", "Catalan", true) }),
        }, offset, landscape);
    }

    /// <summary>The proof capture's content (default corners).</summary>
    public static PosterTagLayout Proof()
    {
        return new PosterTagLayout(new List<PosterTagGroupLayout>
        {
            new(PosterTagGroup.Quality, PosterTagCorner.TopLeft, new PosterTag[] { Q("1080p"), Q("H264") }),
            new(PosterTagGroup.Genre, PosterTagCorner.TopRight, new PosterTag[] { new GenreTag("Science Fiction", "science") }),
            new(PosterTagGroup.Rating, PosterTagCorner.BottomRight, new PosterTag[] { new RatingTag(PosterRatingSource.Community, "8.4", false) }),
            new(PosterTagGroup.AgeRating, PosterTagCorner.BottomRight, new PosterTag[] { new AgeRatingTag("PG-13", "PG-13") }),
            new(PosterTagGroup.Language, PosterTagCorner.BottomLeft, new PosterTag[] { new LanguageTag("gb", "English", false) }),
        }, false, false);
    }

    public static QualityTag Q(string label) => new(label, Category(label));

    /// <summary>A crisp synthetic poster: gradient, sun, mountains and a title, drawn at the requested size.</summary>
    public static SKBitmap Poster(int width, int height, int seed = 0)
    {
        var bmp = new SKBitmap(new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Premul));
        using var c = new SKCanvas(bmp);
        var hue = (seed * 47) % 360;
        using (var shader = SKShader.CreateLinearGradient(new SKPoint(0, 0), new SKPoint(0, height),
                   new[] { SKColor.FromHsl(hue, 45, 18), SKColor.FromHsl((hue + 30) % 360, 40, 34) }, SKShaderTileMode.Clamp))
        using (var p = new SKPaint { Shader = shader })
        {
            c.DrawRect(0, 0, width, height, p);
        }

        using (var p = new SKPaint { IsAntialias = true, Color = SKColor.FromHsl((hue + 180) % 360, 80, 72) })
        {
            c.DrawCircle(width * 0.5f, height * 0.38f, Math.Min(width, height) * 0.36f, p);
        }

        using (var p = new SKPaint { IsAntialias = true, Color = SKColor.FromHsl(hue, 30, 12, 230) })
        using (var path = new SKPath())
        {
            path.MoveTo(0, height * 0.75f);
            path.LineTo(width * 0.3f, height * 0.45f);
            path.LineTo(width * 0.55f, height * 0.7f);
            path.LineTo(width * 0.75f, height * 0.5f);
            path.LineTo(width, height * 0.72f);
            path.LineTo(width, height);
            path.LineTo(0, height);
            path.Close();
            c.DrawPath(path, p);
        }

        using (var font = new SKFont(SKTypeface.Default, width * 0.11f))
        using (var p = new SKPaint { IsAntialias = true, Color = SKColors.White })
        {
            c.DrawText("SIGNAL", width * 0.5f, height * 0.62f, SKTextAlign.Center, font, p);
        }

        return bmp;
    }

    public static byte[] Jpeg(SKBitmap bitmap, int quality = 90)
    {
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Jpeg, quality);
        return data.ToArray();
    }
}

/// <summary>Reproduces the real jellyfin-web captures (proof and corners profiles, 180x270 CSS px at DPR 1).</summary>
internal static class Parity
{
    private static readonly Dictionary<string, PosterTagGroup> ClassToGroup = new()
    {
        ["quality-overlay-container"] = PosterTagGroup.Quality,
        ["genre-overlay-container"] = PosterTagGroup.Genre,
        ["rating-overlay-container"] = PosterTagGroup.Rating,
        ["age-rating-overlay-container"] = PosterTagGroup.AgeRating,
        ["language-overlay-container"] = PosterTagGroup.Language,
    };

    public static int Run(string artifacts, string outDir)
    {
        if (string.IsNullOrEmpty(artifacts) || !Directory.Exists(artifacts))
        {
            Console.WriteLine("parity: --artifacts <.engineering-artifacts/issue-590/web-parity> required");
            return 1;
        }

        // Note: the captures were taken on a host with Noto Sans installed. jellyfin-web's @font-face lists
        // local("Noto Sans Bold") first, so Chromium used the system TTF, whose real small-cap glyphs (smcp) are larger
        // than the synthesised ones the web font gets (fontsource strips smcp). "1080p" is therefore 34px wide in the
        // capture and 33px with the web font (verified in the same Chromium); the renderer follows the web font.
        Console.WriteLine("== parity against real jellyfin-web captures");
        using var renderer = new PosterTagRenderer();
        int rc = 0;
        var summary = new List<object>();
        foreach (var profile in new[] { "proof", "corners" })
        {
            using var baseline = JsonDocument.Parse(File.ReadAllText(Path.Combine(artifacts, $"{profile}-web-baseline.json")));
            using var native = JsonDocument.Parse(File.ReadAllText(Path.Combine(artifacts, $"{profile}-native-layout.json")));
            var layout = BuildLayout(baseline.RootElement.GetProperty("settings"), native.RootElement.GetProperty("boxes"));

            using var basePoster = Program.LoadPng(Path.Combine(artifacts, "web-original.png"));
            using var web = Program.LoadPng(Path.Combine(artifacts, $"{profile}-web-card-180.png"));
            using var rendered = renderer.Render(basePoster, layout) ?? throw new InvalidOperationException("nothing rendered");
            using var ours = Program.Convert(rendered);

            // Rects: container boxes after stacking vs the pinned web layout.
            var plan = renderer.Plan(basePoster.Width, basePoster.Height, layout);
            Console.WriteLine($"-- {profile}\n{plan.Describe()}");
            double maxRectDiff = 0;
            var rects = new List<object>();
            foreach (var webTag in baseline.RootElement.GetProperty("pinned").GetProperty("tags").EnumerateArray())
            {
                var group = ClassToGroup[webTag.GetProperty("class").GetString()!];
                var g = plan.Groups.First(x => x.Group == group);
                double[] w = { webTag.GetProperty("x").GetDouble(), webTag.GetProperty("y").GetDouble(), webTag.GetProperty("width").GetDouble(), webTag.GetProperty("height").GetDouble() };
                double[] n = { g.X, g.Y, g.Width, g.Height };
                double d = w.Zip(n, (a, b) => Math.Abs(a - b)).Max();
                maxRectDiff = Math.Max(maxRectDiff, d);
                Console.WriteLine($"  rect {group,-10} web [{w[0]:0.###}, {w[1]:0.###}, {w[2]:0.###} x {w[3]:0.###}]  native [{n[0]:0.###}, {n[1]:0.###}, {n[2]:0.###} x {n[3]:0.###}]  max |d| {d:0.####}");
                rects.Add(new { group = group.ToString(), web = w, native = n, maxAbsDiff = d });
            }

            var stats = Compare(web, ours, plan);
            Console.WriteLine($"  pixels: {stats}");
            if (maxRectDiff > 1.0)
            {
                Console.WriteLine($"  FAIL: rect difference {maxRectDiff:0.###} px > 1 px");
                rc = 1;
            }

            Program.SavePng(ours, Path.Combine(outDir, $"{profile}-native-180.png"));
            SaveComparison(web, ours, Path.Combine(outDir, $"{profile}-compare.png"));
            summary.Add(new { profile, maxRectDiff, rects, pixels = stats });
        }

        File.WriteAllText(Path.Combine(outDir, "parity.json"), JsonSerializer.Serialize(new { skia = SkiaSharpVersion.Native.ToString(), summary }, new JsonSerializerOptions { WriteIndented = true }));
        return rc;
    }

    private static PosterTagLayout BuildLayout(JsonElement settings, JsonElement boxes)
    {
        PosterTagCorner Corner(string key) => settings.GetProperty(key).GetString() switch
        {
            "top-left" => PosterTagCorner.TopLeft,
            "top-right" => PosterTagCorner.TopRight,
            "bottom-left" => PosterTagCorner.BottomLeft,
            _ => PosterTagCorner.BottomRight,
        };

        var groups = new List<PosterTagGroupLayout>();
        foreach (var box in boxes.EnumerateArray())
        {
            var group = ClassToGroup[box.GetProperty("className").GetString()!];
            var html = box.GetProperty("html").GetString() ?? string.Empty;
            var tags = new List<PosterTag>();
            foreach (var t in box.GetProperty("tags").EnumerateArray())
            {
                var text = t.TryGetProperty("text", out var tt) ? tt.GetString() ?? string.Empty : string.Empty;
                var lines = text.Split('\n');
                switch (group)
                {
                    case PosterTagGroup.Quality:
                        tags.Add(Fixtures.Q(t.GetProperty("quality").GetString()!));
                        break;
                    case PosterTagGroup.Genre:
                        tags.Add(new GenreTag(lines.Length > 1 ? lines[1] : lines[0], lines[0]));
                        break;
                    case PosterTagGroup.Rating:
                        var source = html.Contains("rating-tag-tmdb", StringComparison.Ordinal) ? PosterRatingSource.Community : PosterRatingSource.Critic;
                        tags.Add(new RatingTag(source, lines[^1], !html.Contains("rotten", StringComparison.Ordinal)));
                        break;
                    case PosterTagGroup.AgeRating:
                        var key = System.Text.RegularExpressions.Regex.Match(html, "rating=\"([^\"]+)\"").Groups[1].Value;
                        tags.Add(new AgeRatingTag(text, key));
                        break;
                }
            }

            if (group == PosterTagGroup.Language)
            {
                foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(html, "data-lang=\"([^\"]+)\" data-lang-name=\"([^\"]+)\""))
                {
                    tags.Add(new LanguageTag(m.Groups[1].Value, m.Groups[2].Value, html.Contains("partial", StringComparison.Ordinal)));
                }
            }

            var corner = group switch
            {
                PosterTagGroup.Quality => Corner("qualityTagsPosition"),
                PosterTagGroup.Genre => Corner("genreTagsPosition"),
                PosterTagGroup.Rating => Corner("ratingTagsPosition"),
                PosterTagGroup.AgeRating => Corner("ageRatingTagsPosition"),
                _ => Corner("languageTagsPosition"),
            };
            groups.Add(new PosterTagGroupLayout(group, corner, tags));
        }

        // Paint/stack order of the web: quality, genre, rating, age rating, language.
        groups.Sort((a, b) => a.Group.CompareTo(b.Group));
        return new PosterTagLayout(groups, false, false);
    }

    internal sealed record PixelStats(int Compared, int Differ, int Over8, int Over16, int Over32, int Max, double MeanAll, double MeanTags, int TagPixels)
    {
        public override string ToString() =>
            $"{Differ}/{Compared} differ (>8: {Over8}, >16: {Over16}, >32: {Over32}), max {Max}, mean |d| {MeanAll:0.000} overall, {MeanTags:0.00} over {TagPixels} tag-area px";
    }

    private static PixelStats Compare(SKBitmap web, SKBitmap ours, PosterTagPlan plan)
    {
        int w = web.Width, h = web.Height;
        var tagMask = new bool[w * h];
        foreach (var g in plan.Groups)
        {
            foreach (var i in g.Items)
            {
                int x0 = (int)Math.Floor(i.X - 6), y0 = (int)Math.Floor(i.Y - 6), x1 = (int)Math.Ceiling(i.X + i.Width + 6), y1 = (int)Math.Ceiling(i.Y + i.Height + 8);
                for (int y = Math.Max(0, y0); y < Math.Min(h, y1); y++)
                {
                    for (int x = Math.Max(0, x0); x < Math.Min(w, x1); x++)
                    {
                        tagMask[(y * w) + x] = true;
                    }
                }
            }
        }

        int compared = 0, differ = 0, o8 = 0, o16 = 0, o32 = 0, max = 0, tagPx = 0;
        double sum = 0, tagSum = 0;
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                // The web card has rounded image corners (3x3 px each); not part of the tags.
                bool corner = (x < 3 || x >= w - 3) && (y < 3 || y >= h - 3);
                if (corner)
                {
                    continue;
                }

                var a = web.GetPixel(x, y);
                var b = ours.GetPixel(x, y);
                int d = Math.Max(Math.Abs(a.Red - b.Red), Math.Max(Math.Abs(a.Green - b.Green), Math.Abs(a.Blue - b.Blue)));
                compared++;
                sum += d;
                if (tagMask[(y * w) + x])
                {
                    tagPx++;
                    tagSum += d;
                }

                if (d > 0) differ++;
                if (d > 8) o8++;
                if (d > 16) o16++;
                if (d > 32) o32++;
                max = Math.Max(max, d);
            }
        }

        return new PixelStats(compared, differ, o8, o16, o32, max, sum / compared, tagPx == 0 ? 0 : tagSum / tagPx, tagPx);
    }

    /// <summary>web | native | 4x amplified difference, each upscaled 4x (nearest) for inspection.</summary>
    private static void SaveComparison(SKBitmap web, SKBitmap ours, string path)
    {
        const int Zoom = 4;
        int w = web.Width, h = web.Height;
        using var diff = new SKBitmap(new SKImageInfo(w, h, SKColorType.Rgba8888, SKAlphaType.Premul));
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                var a = web.GetPixel(x, y);
                var b = ours.GetPixel(x, y);
                byte D(byte p, byte q) => (byte)Math.Min(255, Math.Abs(p - q) * 4);
                diff.SetPixel(x, y, new SKColor(D(a.Red, b.Red), D(a.Green, b.Green), D(a.Blue, b.Blue)));
            }
        }

        using var sheet = new SKBitmap(new SKImageInfo(((w * 3) + 8) * Zoom, h * Zoom, SKColorType.Rgba8888, SKAlphaType.Premul));
        using (var c = new SKCanvas(sheet))
        {
            c.Clear(new SKColor(40, 40, 40));
            var sampling = new SKSamplingOptions(SKFilterMode.Nearest, SKMipmapMode.None);
            int x = 0;
            foreach (var b in new[] { web, ours, diff })
            {
                using var img = SKImage.FromBitmap(b);
                c.DrawImage(img, SKRect.Create(x, 0, w * Zoom, h * Zoom), sampling);
                x += (w + 4) * Zoom;
            }
        }

        Program.SavePng(sheet, path);
    }
}

/// <summary>Every quality colour, genre icon, ~20 flags, rating chips and age ratings at 180 and 290 logical width.</summary>
internal static class ContactSheet
{
    public static void Run(string outDir)
    {
        Console.WriteLine("== contact sheet");
        using var renderer = new PosterTagRenderer();
        var cards = new List<(string Title, PosterTagLayout Layout)>();

        foreach (var chunk in Fixtures.QualityLabels.Chunk(8))
        {
            cards.Add(($"quality {chunk[0]}..", Layout(PosterTagGroup.Quality, PosterTagCorner.TopLeft, chunk.Select(l => (PosterTag)Fixtures.Q(l)))));
        }

        foreach (var chunk in Fixtures.GenreIcons.Chunk(7))
        {
            cards.Add(($"genres {chunk[0]}..", Layout(PosterTagGroup.Genre, PosterTagCorner.TopRight, chunk.Select(i => (PosterTag)new GenreTag(i, i)))));
        }

        foreach (var chunk in Fixtures.Flags.Chunk(8))
        {
            // Left column full, right column partial (dimmed, desaturated, dashed).
            cards.Add(($"flags {chunk[0]}..", new PosterTagLayout(new List<PosterTagGroupLayout>
            {
                new(PosterTagGroup.Language, PosterTagCorner.TopLeft, chunk.Select(f => (PosterTag)new LanguageTag(f, f, false)).ToList()),
                new(PosterTagGroup.Language, PosterTagCorner.BottomRight, chunk.Select(f => (PosterTag)new LanguageTag(f, f, true)).ToList()),
            }, false, false)));
        }

        cards.Add(("ratings", Layout(PosterTagGroup.Rating, PosterTagCorner.BottomRight, new PosterTag[]
        {
            new RatingTag(PosterRatingSource.Critic, "91%", true), new RatingTag(PosterRatingSource.Critic, "42%", false),
            new RatingTag(PosterRatingSource.Community, "8.4", false), new RatingTag(PosterRatingSource.Community, "—", false),
            new RatingTag(PosterRatingSource.UserReview, "7.5", false), new RatingTag(PosterRatingSource.UserReview, "10", false),
            new RatingTag(PosterRatingSource.UserReview, "—", false),
        })));

        foreach (var chunk in Fixtures.AgeRatings.Chunk(7))
        {
            // The age container has no gap; one group per badge stacks them with the 4px corner gap instead.
            cards.Add(($"age {chunk[0].Text}..", new PosterTagLayout(
                chunk.Select(a => new PosterTagGroupLayout(PosterTagGroup.AgeRating, PosterTagCorner.TopLeft, new PosterTag[] { new AgeRatingTag(a.Text, a.Key) })).ToList(),
                false, false)));
        }

        cards.Add(("full + top-right offset", Fixtures.Full(false, offset: true)));

        foreach (var landscape in new[] { false, true })
        {
            int logicalW = landscape ? 290 : 180;
            int logicalH = landscape ? 163 : 270;
            const float Zoom = 2f;
            int cardW = (int)(logicalW * Zoom), cardH = (int)(logicalH * Zoom);
            int cols = landscape ? 4 : 6;
            int rows = (cards.Count + cols - 1) / cols;
            int labelH = 22, pad = 12;
            using var sheet = new SKBitmap(new SKImageInfo(cols * (cardW + pad) + pad, rows * (cardH + labelH + pad) + pad, SKColorType.Rgba8888, SKAlphaType.Premul));
            using var c = new SKCanvas(sheet);
            c.Clear(new SKColor(24, 24, 24));
            using var labelFont = new SKFont(SKTypeface.Default, 14);
            using var labelPaint = new SKPaint { IsAntialias = true, Color = new SKColor(220, 220, 220) };
            for (int i = 0; i < cards.Count; i++)
            {
                var (title, layout) = cards[i];
                var l = layout with { Landscape = landscape };
                using var poster = Fixtures.Poster(cardW, cardH, i);
                using var rendered = renderer.Render(poster, l);
                int x = pad + (i % cols) * (cardW + pad);
                int y = pad + (i / cols) * (cardH + labelH + pad);
                c.DrawText(title, x, y + 15, SKTextAlign.Left, labelFont, labelPaint);
                using var img = SKImage.FromBitmap(rendered ?? poster);
                c.DrawImage(img, x, y + labelH);
            }

            Program.SavePng(sheet, Path.Combine(outDir, $"contact-{logicalW}.png"));
        }
    }

    private static PosterTagLayout Layout(PosterTagGroup group, PosterTagCorner corner, IEnumerable<PosterTag> tags)
        => new(new List<PosterTagGroupLayout> { new(group, corner, tags.ToList()) }, false, false);
}

/// <summary>Full layouts at the sizes native clients request.</summary>
internal static class Samples
{
    public static void Run(string outDir)
    {
        Console.WriteLine("== samples");
        using var renderer = new PosterTagRenderer();
        foreach (var (w, h, landscape, offset) in new[]
                 {
                     (180, 270, false, false), (266, 399, false, false), (600, 900, false, false), (600, 900, false, true),
                     (1000, 1500, false, false), (400, 225, true, false), (1280, 720, true, false), (37, 55, false, false),
                 })
        {
            using var poster = Fixtures.Poster(w, h, w + h);
            using var rendered = renderer.Render(poster, Fixtures.Full(landscape, offset));
            Program.SavePng(rendered!, Path.Combine(outDir, $"sample-{w}x{h}{(offset ? "-offset" : string.Empty)}.png"));
        }

        // RenderEncoded round trips in every format.
        using (var poster = Fixtures.Poster(600, 900, 3))
        {
            foreach (var (format, type) in new[] { (SKEncodedImageFormat.Jpeg, "image/jpeg"), (SKEncodedImageFormat.Png, "image/png"), (SKEncodedImageFormat.Webp, "image/webp") })
            {
                using var image = SKImage.FromBitmap(poster);
                using var src = image.Encode(format, 90);
                var output = renderer.RenderEncoded(src.ToArray(), type, 90, Fixtures.Full(false));
                using var codec = SKCodec.Create(SKData.CreateCopy(output!));
                Console.WriteLine($"  RenderEncoded {type}: {src.Size} -> {output!.Length} bytes, decodes as {codec.EncodedFormat} {codec.Info.Width}x{codec.Info.Height}");
                File.WriteAllBytes(Path.Combine(outDir, $"encoded-600x900.{type[6..]}"), output);
            }

            using var big = new SKBitmap(4097, 10);
            Console.WriteLine($"  4097 px wide -> {(renderer.Render(big, Fixtures.Full(false)) is null ? "null (skipped)" : "rendered!?")}");
            Console.WriteLine($"  empty layout -> {(renderer.Render(poster, new PosterTagLayout(new List<PosterTagGroupLayout>(), false, false)) is null ? "null" : "rendered!?")}");
            Console.WriteLine($"  gif -> {(renderer.RenderEncoded(new byte[] { 0x47, 0x49, 0x46 }, "image/gif", 90, Fixtures.Full(false)) is null ? "null" : "?!")}");
        }
    }
}

/// <summary>Determinism under concurrency and a leak check.</summary>
internal static class Stress
{
    public static int Run(int rounds = 1)
    {
        Console.WriteLine("== stress");
        using var renderer = new PosterTagRenderer(4L * 1024 * 1024); // small budget: forces evictions while drawing
        var rnd = new Random(590);
        var layouts = Enumerable.Range(0, 300).Select(_ => RandomLayout(rnd)).ToArray();
        var sizes = new[] { (266, 399), (300, 450), (400, 600), (480, 270) };
        var posters = sizes.Select((s, i) => Fixtures.Poster(s.Item1, s.Item2, i)).ToArray();

        string Hash(int i)
        {
            var poster = posters[i % posters.Length];
            var layout = layouts[i] with { Landscape = poster.Width > poster.Height };
            using var r = renderer.Render(poster, layout);
            return r is null ? "null" : System.Convert.ToHexString(SHA256.HashData(r.GetPixelSpan()));
        }

        var sequential = Enumerable.Range(0, layouts.Length).Select(Hash).ToArray();
        renderer.ClearTileCache();
        var parallel = new string[layouts.Length];
        Parallel.For(0, layouts.Length * 4, new ParallelOptions { MaxDegreeOfParallelism = 8 }, k => parallel[k % layouts.Length] = Hash(k % layouts.Length));
        int mismatches = sequential.Zip(parallel).Count(p => p.First != p.Second);
        Console.WriteLine($"  {layouts.Length} layouts x 4, 8 threads, 4 MiB tile budget: {mismatches} mismatches vs sequential");

        // Leak check: steady-state RSS and managed heap across many renders.
        long Rss() { using var p = Process.GetCurrentProcess(); p.Refresh(); return p.WorkingSet64; }
        void Burst(int n) => Parallel.For(0, n, new ParallelOptions { MaxDegreeOfParallelism = 4 }, k => { var h = Hash(k % layouts.Length); });
        Burst(2000);
        GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
        var line = new StringBuilder($"  RSS / managed heap (MiB) every 20000 renders: {Rss() / 1048576.0:0.0} / {GC.GetTotalMemory(true) / 1048576.0:0.0}");
        for (int round = 0; round < rounds; round++)
        {
            Burst(20000);
            GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
            line.Append($" -> {Rss() / 1048576.0:0.0} / {GC.GetTotalMemory(true) / 1048576.0:0.0}");
        }

        Console.WriteLine(line);
        foreach (var p in posters)
        {
            p.Dispose();
        }

        int rc = mismatches == 0 ? 0 : 1;
        rc |= LongText();
        rc |= DisposeUnderLoad(layouts);
        rc |= FallbackChurn();
        rc |= SharedFallbackSurvivesDispose();
        return rc;
    }

    /// <summary>
    /// Disposing the renderer must leave host fallback faces alive: the font manager hands every caller the same
    /// wrapper, so Jellyfin's own drawing code may hold the very face the renderer used for CJK text. (SkiaSharp
    /// 3.116/3.119 mark those wrappers IgnorePublicDispose, so this guards against a SkiaSharp that stops doing so.)
    /// </summary>
    private static int SharedFallbackSurvivesDispose()
    {
        const int Codepoint = 0x4E2D;
        var shared = SKFontManager.Default.MatchCharacter("Noto Sans", SKFontStyle.Bold, null, Codepoint);
        if (shared is null)
        {
            Console.WriteLine("  shared fallback face after dispose: skipped (no host font covers U+4E2D)");
            return 0;
        }

        using (var poster = Fixtures.Poster(300, 450))
        {
            var renderer = new PosterTagRenderer(0);
            var layout = new PosterTagLayout(new List<PosterTagGroupLayout>
            {
                new(PosterTagGroup.AgeRating, PosterTagCorner.TopLeft, new List<PosterTag> { new AgeRatingTag("\u4E2D\u6587", "x") }),
            }, false, false);
            using (renderer.Render(poster, layout))
            {
            }

            renderer.Dispose();
        }

        bool ok = shared.Handle != IntPtr.Zero && shared.ContainsGlyph(Codepoint);
        if (ok)
        {
            using var font = new SKFont(shared, 20);
            ok = font.MeasureText("\u4E2D") > 0;
        }

        Console.WriteLine($"  shared fallback face after dispose: {(ok ? "ok" : "FAIL (disposed by the renderer)")}");
        return ok ? 0 : 1;
    }

    /// <summary>
    /// 6000 distinct CJK codepoints (host fallback fonts) overflow the fallback index; earlier layouts must still
    /// draw identically afterwards (clearing the index never releases a face in use).
    /// </summary>
    private static int FallbackChurn()
    {
        using var renderer = new PosterTagRenderer(0);
        using var poster = Fixtures.Poster(300, 450);
        PosterTagLayout Layout(int i)
        {
            var text = new string(Enumerable.Range(0, 8).Select(k => (char)(0x4E00 + (i * 8) + k)).ToArray());
            return new PosterTagLayout(new List<PosterTagGroupLayout>
            {
                new(PosterTagGroup.AgeRating, PosterTagCorner.TopLeft, new List<PosterTag> { new AgeRatingTag(text, "x") }),
            }, false, false);
        }

        string Hash(int i)
        {
            using var r = renderer.Render(poster, Layout(i));
            return r is null ? "null" : System.Convert.ToHexString(SHA256.HashData(r.GetPixelSpan()));
        }

        var first = Hash(0);
        var sw = Stopwatch.StartNew();
        Parallel.For(1, 750, new ParallelOptions { MaxDegreeOfParallelism = 8 }, i => Hash(i));
        sw.Stop();
        bool ok = Hash(0) == first;
        Console.WriteLine($"  fallback churn: 6000 CJK codepoints in {sw.Elapsed.TotalMilliseconds:0} ms, first layout identical after: {(ok ? "ok" : "FAIL")}");
        return ok ? 0 : 1;
    }

    /// <summary>Absurd metadata (a 20000-character age rating / rating) must not allocate tiles as wide as its text.</summary>
    private static int LongText()
    {
        using var renderer = new PosterTagRenderer(1L << 30); // cache everything, so the cache holds every tile drawn
        using var poster = Fixtures.Poster(2730, 4096);
        var text = string.Concat(Enumerable.Repeat("NC-17 W", 20000 / 7));
        var layout = new PosterTagLayout(new List<PosterTagGroupLayout>
        {
            new(PosterTagGroup.AgeRating, PosterTagCorner.TopRight, new List<PosterTag> { new AgeRatingTag(text, "NC-17") }),
            new(PosterTagGroup.Rating, PosterTagCorner.BottomLeft, new List<PosterTag> { new RatingTag(PosterRatingSource.Community, text, false) }),
        }, false, false);
        var sw = Stopwatch.StartNew();
        using var r = renderer.Render(poster, layout);
        sw.Stop();
        long bytes = renderer.TileCacheBytes;
        long bound = 2L * (poster.Width + 512) * 1024 * 4; // two chips, each at most image-wide plus shadow margins
        bool ok = r is not null && bytes <= bound;
        Console.WriteLine($"  {text.Length}-char tag text at {poster.Width}x{poster.Height}: tiles {bytes / 1048576.0:0.0} MiB (bound {bound / 1048576.0:0.0}), {sw.Elapsed.TotalMilliseconds:0} ms: {(ok ? "ok" : "FAIL")}");

        // Distinct unknown colour keys (malformed OfficialRating) all paint the default style and share one tile.
        using var small = Fixtures.Poster(180, 270);
        renderer.ClearTileCache();
        for (int i = 0; i < 49; i++)
        {
            var key = i.ToString(CultureInfo.InvariantCulture) + new string('X', 100_000);
            using var keyed = renderer.Render(small, new PosterTagLayout(new List<PosterTagGroupLayout>
            {
                new(PosterTagGroup.AgeRating, PosterTagCorner.TopRight, new List<PosterTag> { new AgeRatingTag("XX", key) }),
            }, false, false));
        }

        int tiles = renderer.TileCacheCount;
        bool keysOk = tiles == 1 && renderer.TileCacheBytes < 64 * 1024;
        Console.WriteLine($"  49 distinct 100k-char colour keys: {tiles} tile(s), {renderer.TileCacheBytes} bytes: {(keysOk ? "ok" : "FAIL")}");
        return ok && keysOk ? 0 : 1;
    }

    /// <summary>Dispose while 8 threads render: no crash; renders after it return null.</summary>
    private static int DisposeUnderLoad(PosterTagLayout[] layouts)
    {
        var renderer = new PosterTagRenderer();
        using var poster = Fixtures.Poster(400, 600);
        int rendered = 0, refused = 0;
        using var go = new ManualResetEventSlim();
        var workers = Enumerable.Range(0, 8).Select(t => Task.Run(() =>
        {
            go.Wait();
            for (int i = 0; i < 400; i++)
            {
                using var r = renderer.Render(poster, layouts[(t * 400 + i) % layouts.Length]);
                Interlocked.Increment(ref r is null ? ref refused : ref rendered);
            }
        })).ToArray();
        go.Set();
        Thread.Sleep(150);
        renderer.Dispose();
        Task.WaitAll(workers);
        using var after = renderer.Render(poster, layouts[0]);
        bool ok = after is null && rendered > 0;
        Console.WriteLine($"  dispose under load: {rendered} rendered, {refused} refused after dispose: {(ok ? "ok" : "FAIL")}");
        return ok ? 0 : 1;
    }

    private static PosterTagLayout RandomLayout(Random rnd)
    {
        T Pick<T>(IReadOnlyList<T> list) => list[rnd.Next(list.Count)];
        PosterTagCorner Corner() => (PosterTagCorner)rnd.Next(4);
        var groups = new List<PosterTagGroupLayout>
        {
            new(PosterTagGroup.Quality, Corner(), Enumerable.Range(0, rnd.Next(0, 5)).Select(_ => (PosterTag)Fixtures.Q(Pick(Fixtures.QualityLabels))).ToList()),
            new(PosterTagGroup.Genre, Corner(), Enumerable.Range(0, rnd.Next(0, 4)).Select(_ => (PosterTag)new GenreTag("g", Pick(Fixtures.GenreIcons))).ToList()),
            new(PosterTagGroup.Rating, Corner(), Enumerable.Range(0, rnd.Next(0, 4)).Select(_ => (PosterTag)new RatingTag((PosterRatingSource)rnd.Next(3), $"{rnd.Next(10)}.{rnd.Next(10)}", rnd.Next(2) == 0)).ToList()),
            new(PosterTagGroup.AgeRating, Corner(), rnd.Next(2) == 0 ? new List<PosterTag>() : new List<PosterTag> { new AgeRatingTag(Pick(Fixtures.AgeRatings).Text, Pick(Fixtures.AgeRatings).Key) }),
            new(PosterTagGroup.Language, Corner(), Enumerable.Range(0, rnd.Next(0, 4)).Select(_ => (PosterTag)new LanguageTag(Pick(Fixtures.Flags), "x", rnd.Next(3) == 0)).ToList()),
        };
        return new PosterTagLayout(groups, rnd.Next(4) == 0, false);
    }
}

/// <summary>ms/poster: tags drawn into an already decoded bitmap, and the full JPEG decode + draw + encode pipeline.</summary>
internal static class Bench
{
    public static void Run(double seconds)
    {
        Console.WriteLine("== bench (proof layout: 2 quality, 1 genre, 1 rating, 1 age, 1 flag; and the full layout)");
        foreach (var (w, h) in new[] { (266, 399), (600, 900) })
        {
            using var poster = Fixtures.Poster(w, h, 7);
            var jpeg = Fixtures.Jpeg(poster);
            using var decoded = SKBitmap.Decode(jpeg);
            foreach (var (name, layout) in new[] { ("proof", Fixtures.Proof()), ("full", Fixtures.Full(false)) })
            {
                using var warm = new PosterTagRenderer();
                using var cold = new PosterTagRenderer(0);
                foreach (var threads in new[] { 1, 4 })
                {
                    double renderWarm = Measure(seconds, threads, () => { using var r = warm.Render(decoded, layout); });
                    double renderCold = Measure(seconds, threads, () => { using var r = cold.Render(decoded, layout); });
                    double pipeWarm = Measure(seconds, threads, () => warm.RenderEncoded(jpeg, "image/jpeg", 90, layout));
                    double baselinePipe = Measure(seconds, threads, () =>
                    {
                        using var b = SKBitmap.Decode(jpeg);
                        using var i = SKImage.FromBitmap(b);
                        using var d = i.Encode(SKEncodedImageFormat.Jpeg, 90);
                    });
                    Console.WriteLine($"  {w}x{h} {name,-5} {threads} thr: render warm {renderWarm:0.000} ms, cold (no tile cache) {renderCold:0.000} ms | " +
                                      $"decode+render+encode JPEG q90 {pipeWarm:0.000} ms (decode+encode alone {baselinePipe:0.000} ms)  [ms per poster{(threads > 1 ? ", wall / posters" : string.Empty)}]");
                }
            }
        }
    }

    /// <summary>Wall-clock ms per operation with <paramref name="threads"/> workers for about <paramref name="seconds"/>.</summary>
    private static double Measure(double seconds, int threads, Action op)
    {
        for (int i = 0; i < 20; i++)
        {
            op();
        }

        long count = 0;
        var sw = Stopwatch.StartNew();
        var until = TimeSpan.FromSeconds(seconds);
        var workers = Enumerable.Range(0, threads).Select(_ => Task.Factory.StartNew(() =>
        {
            long local = 0;
            while (sw.Elapsed < until)
            {
                op();
                local++;
            }

            Interlocked.Add(ref count, local);
        }, TaskCreationOptions.LongRunning)).ToArray();
        Task.WaitAll(workers);
        return sw.Elapsed.TotalMilliseconds / count;
    }
}

/// <summary>Every embedded flag decodes with this Skia line; fonts and HarfBuzz load.</summary>
internal static class AssetCheck
{
    public static int Run()
    {
        Console.WriteLine("== assets");
        var asm = typeof(PosterTagRenderer).Assembly;
        var names = asm.GetManifestResourceNames().Where(n => n.Contains(".Assets.PosterTags.", StringComparison.Ordinal)).ToArray();
        int flags = 0, bad = 0;
        long bytes = 0;
        foreach (var n in names)
        {
            using var s = asm.GetManifestResourceStream(n)!;
            bytes += s.Length;
            if (!n.EndsWith(".webp", StringComparison.Ordinal))
            {
                continue;
            }

            flags++;
            using var ms = new MemoryStream();
            s.CopyTo(ms);
            using var img = SKImage.FromEncodedData(ms.ToArray());
            using var raster = img?.ToRasterImage(true);
            if (raster is null || raster.Width != 160 || raster.Height != 120)
            {
                bad++;
                Console.WriteLine($"  FAILED to decode {n}");
            }
        }

        using var renderer = new PosterTagRenderer();
        using var poster = Fixtures.Poster(180, 270);
        using var r = renderer.Render(poster, Fixtures.Proof());
        Console.WriteLine($"  {names.Length} embedded resources, {bytes} bytes; {flags} WebP flags decoded, {bad} failures; HarfBuzz {(renderer.HarfBuzzUnavailable ? "UNAVAILABLE" : "ok")}");
        bool marks = StackedMarks();
        return bad == 0 && !renderer.HarfBuzzUnavailable && marks ? 0 : 1;
    }

    /// <summary>HarfBuzz stacks a second mark above the first (GPOS y offset): its ink must rise above it.</summary>
    private static bool StackedMarks()
    {
        using var assets = PosterTagAssets.Load();
        using var text = new PosterTagText(assets.TextTypeface);
        int Top(string s)
        {
            using var bitmap = new SKBitmap(new SKImageInfo(160, 120, SKColorType.Rgba8888, SKAlphaType.Premul));
            using var canvas = new SKCanvas(bitmap);
            canvas.Clear(SKColors.Transparent);
            using var paint = new SKPaint { IsAntialias = true, Color = SKColors.White };
            PosterTagText.Draw(canvas, text.Layout(s, 44f, false, 0f), 20f, 100f, paint, true);
            for (int y = 0; y < bitmap.Height; y++)
            {
                for (int x = 0; x < bitmap.Width; x++)
                {
                    if (bitmap.GetPixel(x, y).Alpha > 64)
                    {
                        return y;
                    }
                }
            }

            return bitmap.Height;
        }

        // U+0256 (in the embedded font) carries GPOS mark anchors: the acute stacks on the diaeresis.
        int single = Top("\u0256\u0308"), stacked = Top("\u0256\u0308\u0301");
        bool ok = stacked < single - 4;
        Console.WriteLine($"  stacked marks at 44px: ink top {single} (d-tail + diaeresis) vs {stacked} (+ acute): {(ok ? "ok" : "FAIL")}");
        return ok;
    }
}
