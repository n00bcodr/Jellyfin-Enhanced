using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Collages;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using D = Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Collages.ListCollageLegacyDelivery;
using P = Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Collages.ListCollageLegacyParseStatus;

namespace JE.Tests;

// The collage markers the experimental-list import copied (one unversioned JSON file per list, written by the older
// collage feature) are evidence only: an exact path + content match marks the list's current image as old JE collage
// pixels to withhold; anything uncertain is quarantined, never deleted, adopted or served as safe. The parser gets
// bytes, not paths, and nothing here touches files, the network or a list's image.
public class ListsCollageLegacyEvidenceTests
{
    private const string ListIdN = "0123456789abcdef0123456789abcdef";
    private const string ImagePath = "/config/data/metadata/library/01/0123456789abcdef0123456789abcdef/poster.jpg";
    private static readonly string Sha = new('a', 64);
    private static readonly string OtherSha = new('b', 64);

    // ---- parsing ----------------------------------------------------------------------------------------------------

    [Fact]
    public void TheMarkerTheOlderFeatureWroteIsReadField()
    {
        // As written: compact, these property names, the pending fields null once the write was recorded.
        var json = "{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"" + ImagePath + "\",\"sha256\":\"" + Sha + "\","
            + "\"posterKeys\":[\"/p0.jpg\",\"/p1.jpg\"],\"failedKeys\":[\"/gone.jpg\"],\"setAt\":\"2026-10-01T10:00:00.0000000Z\","
            + "\"pendingSha256\":null,\"pendingPosterKeys\":null}";
        var parsed = Parse(json);

        Assert.Equal(P.Valid, parsed.Status);
        var marker = parsed.Marker!;
        Assert.Equal((ListIdN, ImagePath, Sha), (marker.ListId, marker.ImagePath, marker.Sha256));
        Assert.Equal(new[] { "/p0.jpg", "/p1.jpg" }, marker.PosterKeys);
        Assert.Equal(new[] { "/gone.jpg" }, marker.FailedKeys);
        Assert.Equal("2026-10-01T10:00:00.0000000Z", marker.SetAt);
        Assert.Null(marker.PendingSha256);
        Assert.Null(marker.PendingPosterKeys);

        // A marker with a write still pending next to a recorded image, and one without the optional fields.
        var pending = Parse("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"" + ImagePath + "\",\"sha256\":\"" + Sha + "\",\"posterKeys\":[],\"failedKeys\":[],\"setAt\":\"x\",\"pendingSha256\":\"" + OtherSha + "\",\"pendingPosterKeys\":[\"/p2.jpg\"]}");
        Assert.Equal(P.Valid, pending.Status);
        Assert.Equal(OtherSha, pending.Marker!.PendingSha256);
        Assert.Equal(new[] { "/p2.jpg" }, pending.Marker.PendingPosterKeys);
        Assert.Equal(P.Valid, Parse("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"" + ImagePath + "\",\"sha256\":\"" + Sha + "\"}").Status);
    }

    [Fact]
    public void APendingOnlyOrEmptyMarkerIsNoImageEvidence()
    {
        var pendingOnly = Parse("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"\",\"sha256\":\"\",\"posterKeys\":[],\"failedKeys\":[],\"setAt\":\"\",\"pendingSha256\":\"" + Sha + "\",\"pendingPosterKeys\":[\"/p0.jpg\"]}");
        Assert.Equal(P.PendingOnly, pendingOnly.Status);
        Assert.Equal(Sha, pendingOnly.Marker!.PendingSha256);
        Assert.Equal(P.NoEvidence, Parse("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"\",\"sha256\":\"\"}").Status);
        Assert.Equal(P.NoEvidence, Parse("{\"listId\":\"" + ListIdN + "\"}").Status);

        // A path without a hash, or a hash without a path, proves nothing.
        Assert.Equal(P.NoEvidence, Parse("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"" + ImagePath + "\",\"sha256\":\"\"}").Status);
        Assert.Equal(P.NoEvidence, Parse("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"\",\"sha256\":\"" + Sha + "\"}").Status);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("null")]
    [InlineData("{\"listId\":\"" + ListIdN + "\"")]
    [InlineData("{\"listId\":\"" + ListIdN + "\"} trailing")]
    [InlineData("{\"listId\":42}")]
    [InlineData("{\"imagePath\":\"/x.jpg\"}")]
    [InlineData("{\"listId\":\"" + ListIdN + "\",\"listId\":\"" + ListIdN + "\"}")]
    [InlineData("{\"listId\":\"" + ListIdN + "\",\"posterKeys\":\"/p0.jpg\"}")]
    [InlineData("{\"listId\":\"" + ListIdN + "\",\"posterKeys\":[1]}")]
    [InlineData("{\"listId\":\"" + ListIdN + "\",\"posterKeys\":[[\"/p0.jpg\"]]}")]
    [InlineData("{\"listId\":\"" + ListIdN + "\",\"posterKeys\":[{\"a\":1}]}")]
    [InlineData("{\"listId\":\"" + ListIdN + "\",\"sha256\":null,\"imagePath\":null}")]
    public void AnythingButTheMarkersOwnShapeIsMalformed(string json)
    {
        var parsed = Parse(json);
        Assert.Equal(P.Malformed, parsed.Status);
        Assert.Null(parsed.Marker);
    }

    // Every way the bytes fail to decode (reader or string decoder, at any position) is Malformed: never an exception,
    // never a marker. Generated from a fixed table of bad fragments x every place a string can sit in the marker.
    [Fact]
    public void EveryDecodeFailureAnywhereIsMalformedNotAnException()
    {
        var failures = new List<string>();
        var cases = 0;
        foreach (var (label, fragment) in BadFragments())
        {
            foreach (var (place, json) in Placements(fragment))
            {
                cases++;
                ListCollageLegacyParse parsed;
                try
                {
                    parsed = ListCollageLegacyEvidence.Parse(json, ListIdN);
                }
                catch (Exception ex)
                {
                    failures.Add($"{label} in {place}: threw {ex.GetType().Name}");
                    continue;
                }

                if (parsed.Status != P.Malformed || parsed.Marker != null)
                {
                    failures.Add($"{label} in {place}: {parsed.Status}{(parsed.Marker != null ? " with a marker" : string.Empty)}");
                }
            }
        }

        Assert.True(cases >= 300, "fuzz table shrank: " + cases);
        var byOutcome = failures.GroupBy(f => f[(f.IndexOf(": ", StringComparison.Ordinal) + 2)..]).Select(g => g.Key + " x" + g.Count());
        Assert.True(failures.Count == 0, failures.Count + " of " + cases + " decode failures were not Malformed (" + string.Join("; ", byOutcome) + "):\n" + string.Join("\n", failures.Take(60)));
    }

    // Seeded byte mutations of a complete marker (bounded): whatever the bytes become, Parse answers with a status and
    // never throws; only Valid and PendingOnly carry a marker.
    [Fact]
    public void MutatedMarkerBytesAlwaysGetAStatusNeverAnException()
    {
        var original = Encoding.UTF8.GetBytes("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"" + ImagePath + "\",\"sha256\":\"" + Sha + "\",\"posterKeys\":[\"/p\\u00e90.jpg\",\"/p1.jpg\"],\"failedKeys\":[\"/gone.jpg\"],\"setAt\":\"2026-10-01T10:00:00Z\",\"pendingSha256\":null,\"pendingPosterKeys\":[\"/p2.jpg\"]}");
        var random = new Random(4313);
        var insert = new byte[][] { Encoding.ASCII.GetBytes("\\ud800"), Encoding.ASCII.GetBytes("\\udc00"), Encoding.ASCII.GetBytes("\\u"), new byte[] { 0xed, 0xa0, 0x80 }, new byte[] { 0xc0, 0x80 }, new byte[] { 0 }, new byte[] { 0xff } };
        var thrown = new List<string>();
        for (var i = 0; i < 3000; i++)
        {
            var bytes = original.ToList();
            for (var edits = random.Next(1, 4); edits > 0; edits--)
            {
                var at = random.Next(bytes.Count);
                switch (random.Next(3))
                {
                    case 0:
                        bytes[at] = (byte)random.Next(256);
                        break;
                    case 1:
                        bytes.InsertRange(at, insert[random.Next(insert.Length)]);
                        break;
                    default:
                        bytes.RemoveAt(at);
                        break;
                }
            }

            try
            {
                var parsed = ListCollageLegacyEvidence.Parse(bytes.ToArray(), ListIdN);
                Assert.Equal(parsed.Status is P.Valid or P.PendingOnly, parsed.Marker != null);
            }
            catch (Exception ex) when (ex is not Xunit.Sdk.XunitException)
            {
                thrown.Add(ex.GetType().Name + ": " + Convert.ToHexString(bytes.ToArray()));
            }
        }

        Assert.True(thrown.Count == 0, thrown.Count + " mutated markers threw:\n" + string.Join("\n", thrown.Take(10)));
    }

    // Valid Unicode (escaped or raw), controls included, decodes like any other text: the marker stays Valid.
    [Fact]
    public void ValidUnicodeAndEscapedControlsStayValid()
    {
        foreach (var (label, fragment) in GoodFragments())
        {
            foreach (var (place, json) in Placements(fragment, includePropertyName: false))
            {
                var parsed = ListCollageLegacyEvidence.Parse(json, ListIdN);
                Assert.True(parsed.Status == P.Valid && parsed.Marker != null, $"{label} in {place}: {parsed.Status}");
            }
        }

        // An escaped spelling of a known property name is that name.
        var escapedName = Encoding.UTF8.GetBytes("{\"\\u006cistId\":\"" + ListIdN + "\",\"imagePath\":\"" + ImagePath + "\",\"sha256\":\"" + Sha + "\"}");
        Assert.Equal(P.Valid, ListCollageLegacyEvidence.Parse(escapedName, ListIdN).Status);

        // Text decoded exactly: a raw and an escaped emoji, a control and a line separator in a poster key.
        var keys = ListCollageLegacyEvidence.Parse(Encoding.UTF8.GetBytes("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"" + ImagePath + "\",\"sha256\":\"" + Sha + "\",\"posterKeys\":[\"/\U0001F3AC\\ud83c\\udfac\\u0001\\u2028.jpg\"]}"), ListIdN);
        Assert.Equal("/\U0001F3AC\U0001F3AC\u0001\u2028.jpg", Assert.Single(keys.Marker!.PosterKeys));

        // A control character in the image path is still an ambiguous path (not a decode failure).
        Assert.Equal(P.InvalidPath, Parse("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"/config/a\\u0001b.jpg\",\"sha256\":\"" + Sha + "\"}").Status);
    }

    [Fact]
    public void AnUnknownFieldMeansAnUnknownFormat()
    {
        Assert.Equal(P.UnknownSchema, Parse("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"" + ImagePath + "\",\"sha256\":\"" + Sha + "\",\"schema\":2}").Status);
        Assert.Equal(P.UnknownSchema, Parse("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"" + ImagePath + "\",\"sha256\":\"" + Sha + "\",\"owner\":\"someone\"}").Status);
        Assert.Equal(P.UnknownSchema, Parse("{\"ListId\":\"" + ListIdN + "\"}").Status); // names are exact
    }

    [Fact]
    public void AnotherListsMarkerIsNotThisListsEvidence()
    {
        var other = "fedcba9876543210fedcba9876543210";
        Assert.Equal(P.WrongList, Parse("{\"listId\":\"" + other + "\",\"imagePath\":\"" + ImagePath + "\",\"sha256\":\"" + Sha + "\"}").Status);
        Assert.Equal(P.WrongList, Parse("{\"listId\":\"" + ListIdN.ToUpperInvariant() + "\",\"imagePath\":\"" + ImagePath + "\",\"sha256\":\"" + Sha + "\"}").Status);
        Assert.Throws<ArgumentException>(() => ListCollageLegacyEvidence.Parse(Encoding.UTF8.GetBytes("{}"), "../etc"));
        Assert.Throws<ArgumentException>(() => ListCollageLegacyEvidence.Parse(Encoding.UTF8.GetBytes("{}"), null!));
    }

    [Theory]
    [InlineData("ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789")] // upper case: not what was written
    [InlineData("aaaa")]
    [InlineData("gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    public void AHashThatIsNotLowercaseSha256HexIsInvalid(string hash)
    {
        Assert.Equal(P.InvalidHash, Parse("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"" + ImagePath + "\",\"sha256\":\"" + hash + "\"}").Status);
        Assert.Equal(P.InvalidHash, Parse("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"\",\"sha256\":\"\",\"pendingSha256\":\"" + hash + "\"}").Status);
    }

    [Theory]
    [InlineData("poster.jpg")]
    [InlineData("./poster.jpg")]
    [InlineData("/config/data/../../etc/poster.jpg")]
    [InlineData("/config/data/./poster.jpg")]
    [InlineData("/config//data/poster.jpg")]
    [InlineData("/config/data/")]
    [InlineData("C:\\\\ProgramData\\\\jellyfin\\\\poster.jpg")]
    [InlineData("/config/data\\\\poster.jpg")]
    [InlineData("~/poster.jpg")]
    [InlineData("/config/data/poster.jpg\\u0000.png")]
    [InlineData("/config/data/\\u202eposter.jpg")]
    public void AnAmbiguousOrEscapingPathIsInvalid(string path)
    {
        Assert.Equal(P.InvalidPath, Parse("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"" + path + "\",\"sha256\":\"" + Sha + "\"}").Status);
    }

    [Fact]
    public void SizeDepthCountAndLengthAreBounded()
    {
        Assert.Equal(16 * 1024, ListCollageLegacyEvidence.MaxBytes);
        var padding = new string(' ', ListCollageLegacyEvidence.MaxBytes);
        Assert.Equal(P.TooLarge, Parse("{\"listId\":\"" + ListIdN + "\"}" + padding).Status);

        var keys = string.Join(',', Enumerable.Range(0, ListCollageLegacyEvidence.MaxArrayItems + 1).Select(i => "\"/p" + i + ".jpg\""));
        Assert.Equal(P.TooLarge, Parse("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"" + ImagePath + "\",\"sha256\":\"" + Sha + "\",\"failedKeys\":[" + keys + "]}").Status);
        var fits = string.Join(',', Enumerable.Range(0, ListCollageLegacyEvidence.MaxArrayItems).Select(i => "\"/p" + i + ".jpg\""));
        Assert.Equal(P.Valid, Parse("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"" + ImagePath + "\",\"sha256\":\"" + Sha + "\",\"failedKeys\":[" + fits + "]}").Status);

        var longPath = "/" + new string('a', ListCollageLegacyEvidence.MaxStringLength) + ".jpg";
        Assert.Equal(P.TooLarge, Parse("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"" + longPath + "\",\"sha256\":\"" + Sha + "\"}").Status);
        Assert.Equal(P.TooLarge, Parse("{\"listId\":\"" + ListIdN + "\",\"setAt\":\"" + new string('1', ListCollageLegacyEvidence.MaxStringLength + 1) + "\"}").Status);

        var deep = string.Concat(Enumerable.Repeat("[", 64)) + string.Concat(Enumerable.Repeat("]", 64));
        Assert.Equal(P.Malformed, Parse("{\"listId\":\"" + ListIdN + "\",\"posterKeys\":" + deep + "}").Status);
    }

    // ---- classification ---------------------------------------------------------------------------------------------

    [Fact]
    public void AnExactCurrentPathAndHashMatchIsOldCollagePixelsToWithhold()
    {
        var marker = Valid();
        Assert.Equal(D.WithholdLegacy, Classify(marker, Native(ImagePath, Sha)));

        // A supersession claim can't make JE's own pixels someone else's.
        Assert.Equal(D.WithholdLegacy, Classify(marker, Native(ImagePath, Sha), supersession: new ListCollageSupersession("upload-event")));
    }

    [Fact]
    public void AnythingUncertainAboutAnImportedListsImageIsQuarantinedNotServed()
    {
        var marker = Valid();
        Assert.Equal(D.QuarantineUncertain, Classify(marker, Native(ImagePath, OtherSha)));                         // same path, other bytes
        Assert.Equal(D.QuarantineUncertain, Classify(marker, Native("/config/data/metadata/other/poster.jpg", Sha))); // same bytes, other path
        Assert.Equal(D.QuarantineUncertain, Classify(marker, Native(ImagePath.ToUpperInvariant(), Sha)));             // paths compare exactly
        Assert.Equal(D.QuarantineUncertain, Classify(marker, Native(ImagePath, Sha) with { PathExact = false }));     // through a link or not resolved
        Assert.Equal(D.QuarantineUncertain, Classify(marker, Native(ImagePath, null)));                               // couldn't hash the file
        Assert.Equal(D.QuarantineUncertain, Classify(Parse("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"\",\"sha256\":\"\",\"pendingSha256\":\"" + Sha + "\"}"), Native(ImagePath, Sha))); // pending only
        Assert.Equal(D.QuarantineUncertain, Classify(Parse("{broken"), Native(ImagePath, Sha)));
        Assert.Equal(D.QuarantineUncertain, Classify(Parse("{\"listId\":\"fedcba9876543210fedcba9876543210\",\"imagePath\":\"" + ImagePath + "\",\"sha256\":\"" + Sha + "\"}"), Native(ImagePath, Sha)));
        Assert.Equal(D.QuarantineUncertain, Classify(Parse("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"../poster.jpg\",\"sha256\":\"" + Sha + "\"}"), Native("../poster.jpg", Sha)));
        Assert.Equal(D.QuarantineUncertain, Classify(null, Native(ImagePath, Sha), importCandidate: true));           // marker lost after import
    }

    [Fact]
    public void OnlyPositiveSupersessionLetsTheListsCurrentImageThrough()
    {
        var supersession = new ListCollageSupersession("native-upload-after-import");
        Assert.Equal(D.NativeSupersedes, Classify(Valid(), Native(ImagePath, OtherSha), supersession: supersession));
        Assert.Equal(D.NativeSupersedes, Classify(null, Native(ImagePath, OtherSha), importCandidate: true, supersession: supersession));
        Assert.Throws<ArgumentException>(() => new ListCollageSupersession(" "));
    }

    [Fact]
    public void ListsWithNoLegacyAssociationAreUntouchedAndAbsentImagesNeedNoDecision()
    {
        // An unrelated list image, even a 600x600 PNG in the list's metadata folder, is not judged by its looks.
        Assert.Equal(D.NativeUnchanged, Classify(null, Native("/config/data/metadata/library/ab/list/poster.png", Sha)));
        Assert.Equal(D.NativeUnchanged, Classify(null, Native("/media/lists/my list/folder.jpg", null) with { PathExact = false }));

        // No image on the list: nothing legacy to serve, whatever the marker says.
        Assert.Equal(D.NoNativePrimary, Classify(Valid(), new ListCollageNativePrimaryEvidence(false, null, null, true)));
        Assert.Equal(D.NoNativePrimary, Classify(null, new ListCollageNativePrimaryEvidence(false, null, null, true), importCandidate: true));
    }

    // ---- inert: no I/O, no native image effects, no registration ----------------------------------------------------

    [Fact]
    public void TheParserAndClassifierOnlyReturnEvidence()
    {
        var methods = typeof(ListCollageLegacyEvidence).GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static).Select(m => m.Name).Distinct().OrderBy(n => n, StringComparer.Ordinal);
        Assert.Equal(new[] { "Classify", "Parse" }, methods);
        Assert.Equal(
            new[] { "NativeSupersedes", "NativeUnchanged", "NoNativePrimary", "QuarantineUncertain", "WithholdLegacy" },
            Enum.GetNames<ListCollageLegacyDelivery>().OrderBy(n => n, StringComparer.Ordinal));

        // Evidence is kept as it was read: parsing the same bytes twice gives equal markers.
        var json = Encoding.UTF8.GetBytes("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"" + ImagePath + "\",\"sha256\":\"" + Sha + "\",\"posterKeys\":[\"/p0.jpg\"]}");
        var copy = (byte[])json.Clone();
        var first = ListCollageLegacyEvidence.Parse(json, ListIdN);
        Assert.Equal(copy, json);
        Assert.Equal(first.Marker!.PosterKeys, ListCollageLegacyEvidence.Parse(json, ListIdN).Marker!.PosterKeys);
    }

    [Fact]
    public void NoCollageModuleTouchesFilesTheNetworkNativeImagesOrStartup()
    {
        // From the test binaries or (when they are built outside the repository) this source file.
        var root = new[] { AppContext.BaseDirectory, Path.GetDirectoryName(ThisFile())! }
            .Select(start =>
            {
                var dir = new DirectoryInfo(start);
                while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "Jellyfin.Plugin.JellyfinEnhanced")))
                {
                    dir = dir.Parent;
                }

                return dir;
            })
            .FirstOrDefault(dir => dir != null);

        Assert.NotNull(root);
        var plugin = Path.Combine(root!.FullName, "Jellyfin.Plugin.JellyfinEnhanced");
        var files = Directory.GetFiles(Path.Combine(plugin, "Services", "Acquire", "Lists", "Collages"), "*.cs");
        Assert.Equal(
            new[] { "ListCollageConsentRules.cs", "ListCollageLegacyEvidence.cs", "ListCollagePosterSet.cs", "ListCollageRenderer.cs" },
            files.Select(Path.GetFileName).OrderBy(n => n, StringComparer.Ordinal));

        var forbidden = new HashSet<string>(StringComparer.Ordinal)
        {
            "File", "Directory", "FileInfo", "DirectoryInfo", "FileStream", "StreamReader", "StreamWriter", "Path",
            "HttpClient", "IHttpClientFactory", "HttpRequestMessage", "Socket", "TcpListener", "WebRequest",
            "ILibraryManager", "IProviderManager", "IImageProcessor", "ItemImageInfo", "BaseItem",
            "SaveImage", "SetImage", "SetImagePath", "DeleteImage", "DeleteImageAsync", "RemoveImage", "UpdateToRepositoryAsync", "UpdateItemAsync",
            "IHostedService", "BackgroundService", "Timer", "PeriodicTimer", "ThreadPool", "Thread", "Process",
            "ListStore", "ListService", "ListHost", "IListHost", "ListLifecycle", "AcquireDatabase", "Environment",
        };
        foreach (var file in files)
        {
            var tree = CSharpSyntaxTree.ParseText(File.ReadAllText(file));
            var names = tree.GetRoot().DescendantNodes().OfType<SimpleNameSyntax>().Select(n => n.Identifier.Text).ToHashSet(StringComparer.Ordinal);
            var hits = names.Where(forbidden.Contains).ToList();
            Assert.True(hits.Count == 0, $"{Path.GetFileName(file)} uses {string.Join(", ", hits)}");
            var usings = tree.GetRoot().DescendantNodes().OfType<UsingDirectiveSyntax>().Select(u => u.Name!.ToString()).ToList();
            Assert.DoesNotContain(usings, u => u.StartsWith("System.IO", StringComparison.Ordinal) || u.StartsWith("System.Net", StringComparison.Ordinal) || u.StartsWith("MediaBrowser.Controller", StringComparison.Ordinal) || u.StartsWith("Microsoft.Extensions.Hosting", StringComparison.Ordinal));
        }

        // Nothing registers or starts the package.
        var registrator = File.ReadAllText(Path.Combine(plugin, "PluginServiceRegistrator.cs"));
        Assert.DoesNotContain("Collages", registrator, StringComparison.Ordinal);
        Assert.DoesNotContain("ListCollage", registrator, StringComparison.Ordinal);
        foreach (var type in typeof(ListCollageRenderer).Assembly.GetTypes().Where(t => t.Namespace == typeof(ListCollageRenderer).Namespace))
        {
            System.Runtime.CompilerServices.RuntimeHelpers.RunClassConstructor(type.TypeHandle);
            Assert.False(typeof(Microsoft.Extensions.Hosting.IHostedService).IsAssignableFrom(type), type.Name);
            Assert.False(typeof(IDisposable).IsAssignableFrom(type) && type != typeof(ListCollageRenderTrace), type.Name);
        }
    }

    // ---- fixtures ---------------------------------------------------------------------------------------------------

    private static string ThisFile([System.Runtime.CompilerServices.CallerFilePath] string path = "") => path;

    private static ListCollageLegacyParse Parse(string json) => ListCollageLegacyEvidence.Parse(Encoding.UTF8.GetBytes(json), ListIdN);

    // Bytes that can't decode inside a JSON string: escapes that make no text (unpaired or reversed surrogates), escapes
    // JSON doesn't have, raw NUL and other raw controls, and UTF-8 that isn't (overlong, encoded surrogates, stray or
    // truncated sequences, past U+10FFFF).
    private static IEnumerable<(string Label, byte[] Fragment)> BadFragments()
    {
        static byte[] A(string s) => Encoding.ASCII.GetBytes(s);
        foreach (var escape in new[]
                 {
                     "\\ud800", "\\udbff", "\\udc00", "\\udfff", "\\ud800x", "\\ud800\\u0041", "\\udc00\\ud800", "\\ud800\\ud800",
                     "\\udfff\\udfff", "a\\ud834", "\\uDC00", "\\uD83C\\u0020\\uDFAC",
                     "\\x41", "\\u12", "\\u12g4", "\\U0041", "\\'", "\\0", "\\a", "\\u", "\\u-123", "\\v",
                 })
        {
            yield return ("escape " + escape, A(escape));
        }

        foreach (var raw in new[]
                 {
                     new byte[] { 0x00 }, new byte[] { 0x01 }, new byte[] { 0x1f }, new byte[] { 0x0a }, new byte[] { 0x41, 0x00, 0x42 },
                     new byte[] { 0xc0, 0x80 }, new byte[] { 0xc1, 0xbf }, new byte[] { 0xe0, 0x80, 0x80 }, new byte[] { 0xf0, 0x80, 0x80, 0x80 },
                     new byte[] { 0xed, 0xa0, 0x80 }, new byte[] { 0xed, 0xbf, 0xbf }, new byte[] { 0x80 }, new byte[] { 0xbf }, new byte[] { 0xff },
                     new byte[] { 0xfe }, new byte[] { 0xf5, 0x80, 0x80, 0x80 }, new byte[] { 0xf4, 0x90, 0x80, 0x80 }, new byte[] { 0xc3 },
                     new byte[] { 0xe2, 0x82 }, new byte[] { 0xf0, 0x9f, 0x8e },
                 })
        {
            yield return ("raw " + Convert.ToHexString(raw), raw);
        }
    }

    private static IEnumerable<(string Label, byte[] Fragment)> GoodFragments()
    {
        static byte[] A(string s) => Encoding.ASCII.GetBytes(s);
        foreach (var escape in new[] { "\\u0000", "\\u0001", "\\u001f", "\\t", "\\n", "\\r", "\\b", "\\f", "\\u007f", "\\u0085", "\\u2028", "\\u202e", "\\ufeff", "\\ud83c\\udfac", "\\uDBFF\\uDFFF", "\\\"", "\\\\", "\\/" })
        {
            yield return ("escape " + escape, A(escape));
        }

        foreach (var text in new[] { "\u007f", "\u0085", "é", "日本", "\U0001F3AC", "\U0010FFFF", "\u2028" })
        {
            yield return ("raw " + Convert.ToHexString(Encoding.UTF8.GetBytes(text)), Encoding.UTF8.GetBytes(text));
        }
    }

    // A complete Valid marker with the fragment spliced into one string: a property name, each scalar text value (in the
    // middle of the value, so a valid fragment keeps hashes and the path as they are where those can't hold text) and an
    // element of each array.
    private static IEnumerable<(string Place, byte[] Json)> Placements(byte[] fragment, bool includePropertyName = true)
    {
        var fields = new (string Name, string Value)[]
        {
            ("listId", "\"" + ListIdN + "\""), ("imagePath", "\"" + ImagePath + "\""), ("sha256", "\"" + Sha + "\""),
            ("posterKeys", "[\"/p0.jpg\",\"/p1.jpg\"]"), ("failedKeys", "[\"/gone.jpg\"]"), ("setAt", "\"2026-10-01T10:00:00Z\""),
            ("pendingSha256", "null"), ("pendingPosterKeys", "[\"/p2.jpg\"]"),
        };

        byte[] Build(Func<int, string, string, (string Name, byte[]? NameFragment, string Value, byte[]? ValueFragment)> edit)
        {
            using var json = new MemoryStream();
            void W(string s) => json.Write(Encoding.UTF8.GetBytes(s));

            // The fragment goes at the first "|" of the edited text.
            void Spliced(string text, byte[]? part)
            {
                var at = part == null ? -1 : text.IndexOf('|', StringComparison.Ordinal);
                W(at < 0 ? text : text[..at]);
                if (at >= 0)
                {
                    json.Write(part);
                    W(text[(at + 1)..]);
                }
            }

            W("{");
            for (var i = 0; i < fields.Length; i++)
            {
                var (name, nameFragment, value, valueFragment) = edit(i, fields[i].Name, fields[i].Value);
                W(i > 0 ? "," : string.Empty);
                Spliced("\"" + name + "\"", nameFragment);
                W(":");
                Spliced(value, valueFragment);
            }

            W("}");
            return json.ToArray();
        }

        if (includePropertyName)
        {
            yield return ("property name (known)", Build((i, n, v) => i == 0 ? ("list|Id", fragment, v, null) : (n, null, v, null)));
            yield return ("property name (new)", Build((i, n, v) => i == 7 ? ("x|", fragment, v, null) : (n, null, v, null)));
        }

        // Text-carrying scalars (a fragment in listId/sha256 would only be a wrong list or hash if it decoded).
        foreach (var target in includePropertyName ? new[] { "setAt", "imagePath" } : new[] { "setAt" })
        {
            yield return (target + " value", Build((i, n, v) => n == target ? (n, null, target == "imagePath" ? "\"/config/data/a|b.jpg\"" : "\"2026|\"", fragment) : (n, null, v, null)));
        }

        if (includePropertyName)
        {
            foreach (var target in new[] { "listId", "sha256", "pendingSha256" })
            {
                yield return (target + " value", Build((i, n, v) => n == target ? (n, null, "\"|\"", fragment) : (n, null, v, null)));
            }
        }

        foreach (var target in new[] { "posterKeys", "failedKeys", "pendingPosterKeys" })
        {
            yield return (target + " element", Build((i, n, v) => n == target ? (n, null, "[\"/p0.jpg\",\"/p|.jpg\"]", fragment) : (n, null, v, null)));
            yield return (target + " first element", Build((i, n, v) => n == target ? (n, null, "[\"|\"]", fragment) : (n, null, v, null)));
        }
    }

    private static ListCollageLegacyParse Valid() =>
        Parse("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"" + ImagePath + "\",\"sha256\":\"" + Sha + "\",\"posterKeys\":[\"/p0.jpg\"],\"failedKeys\":[],\"setAt\":\"2026-10-01T10:00:00Z\",\"pendingSha256\":null,\"pendingPosterKeys\":null}");

    private static ListCollageNativePrimaryEvidence Native(string path, string? sha) => new(true, path, sha, true);

    private static ListCollageLegacyDelivery Classify(ListCollageLegacyParse? marker, ListCollageNativePrimaryEvidence native, bool importCandidate = false, ListCollageSupersession? supersession = null) =>
        ListCollageLegacyEvidence.Classify(marker, native, importCandidate, supersession);
}
