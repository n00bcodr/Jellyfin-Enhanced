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

    private static ListCollageLegacyParse Valid() =>
        Parse("{\"listId\":\"" + ListIdN + "\",\"imagePath\":\"" + ImagePath + "\",\"sha256\":\"" + Sha + "\",\"posterKeys\":[\"/p0.jpg\"],\"failedKeys\":[],\"setAt\":\"2026-10-01T10:00:00Z\",\"pendingSha256\":null,\"pendingPosterKeys\":null}");

    private static ListCollageNativePrimaryEvidence Native(string path, string? sha) => new(true, path, sha, true);

    private static ListCollageLegacyDelivery Classify(ListCollageLegacyParse? marker, ListCollageNativePrimaryEvidence native, bool importCandidate = false, ListCollageSupersession? supersession = null) =>
        ListCollageLegacyEvidence.Classify(marker, native, importCandidate, supersession);
}
