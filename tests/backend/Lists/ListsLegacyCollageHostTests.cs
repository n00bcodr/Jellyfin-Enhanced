using System.Text.Json.Nodes;

namespace JE.Tests;

// Closed PR #936 drew collages of member posters into lists' native Primary images. Those posters can be ones a viewer
// has hidden since or that Spoiler Guard covers, so the collage, everything derived from it and the library tiles the
// host composes from list images must reach nobody, on both Jellyfin versions, while every other image is served (and
// revalidated) exactly as before. Executed through the pinned release's real ImageController and SearchController
// and the plugin's real registered filter chain (LegacyCollageHost).
public class ListsLegacyCollageHostTests
{
    private static readonly string[] Withheld = { "legacy", "pending", "corrupt" };
    private static readonly string[] Served = { "custom", "unrelated", "unrelatedset", "movieslibrary" };

    private static IEnumerable<JsonObject> Images(JsonObject run, Func<JsonObject, bool> where)
        => run["images"]!.AsArray().Select(n => n!.AsObject()).Where(where);

    private static string S(JsonObject o, string key) => o[key]?.GetValue<string>() ?? string.Empty;

    private static string Describe(JsonObject r) => $"{S(r, "item")} {S(r, "imageType")} {S(r, "alias")} {S(r, "method")} {S(r, "caller")} {S(r, "conditional")} -> {r["status"]}";

    [Fact]
    public void TheHostRunIsTheRealReleaseWithThePluginsFilterChain()
    {
        var run = LegacyCollageHost.Run();
        var expected = JellyfinApiAssembly.CurrentLine == "jf12" ? "12.2" : "10.11.11";
        Assert.Equal(expected, S(run, "release"));
        Assert.StartsWith(expected == "12.2" ? "12.2." : "10.11.11", S(run, "server"));
        var filters = run["filters"]!.AsArray().Select(f => f!.GetValue<string>()).ToList();
        foreach (var name in new[] { "HiddenContentResponseFilter", "SpoilerIdentityTagFilter", "SpoilerFieldStripFilter", "PosterTagImageFilter", "SpoilerBlurImageFilter", "JellyfinUserChangeBracket" })
            Assert.Contains(filters, f => f.StartsWith(name + "@", StringComparison.Ordinal));
        Assert.True(run["filesUnchanged"]!.GetValue<bool>(), "no image or marker file may change");
    }

    [Fact]
    public void ALegacyCollageIsServedOnNoAliasMethodCallerOrConditionalAndTheHostSaysItHasNoImage()
    {
        var run = LegacyCollageHost.Run();
        var rows = Images(run, r => Withheld.Contains(S(r, "item")) && S(r, "imageType") == "Primary").ToList();
        // 3 lists × 8 aliases × GET/HEAD × 3 callers × (none, if-modified-since, + if-none-match on the 5 tagged aliases).
        Assert.Equal(3 * (8 * 2 * 3 * 2 + 5 * 2 * 3), rows.Count);
        var leaks = rows.Where(r => r["status"]!.GetValue<int>() != 404 || r["servedImage"]!.GetValue<bool>() || r["etag"] != null || r["lastModified"] != null).Select(Describe).ToList();
        Assert.True(leaks.Count == 0, "served: " + string.Join("; ", leaks.Take(12)) + (leaks.Count > 12 ? $" (+{leaks.Count - 12})" : string.Empty));
        foreach (var row in rows.Where(r => S(r, "method") == "GET"))
            Assert.Equal($"\"{S(row, "item")} list does not have an image of type Primary\"", S(row, "body"));
    }

    [Fact]
    public void EveryOtherImageIsServedAndTheHostsOwnConditionalAnswersStillComeBack()
    {
        var run = LegacyCollageHost.Run();
        var jf12 = JellyfinApiAssembly.CurrentLine == "jf12";
        var rows = Images(run, r => Served.Contains(S(r, "item"))).ToList();
        Assert.Equal(Served.Length * (8 * 2 * 3 * 2 + 5 * 2 * 3), rows.Count);
        foreach (var row in rows)
        {
            var tagged = S(row, "alias") is "tagged" or "index-tagged" or "sized" or "path-form" or "lowercase";
            // The release's own rules: 12.2's controller answers If-None-Match on the tag; 10.11.11 sends no ETag. On
            // both, If-Modified-Since gets a 304 from the controller (tagged URLs) or from MVC's physical-file executor,
            // which validates against the file's own modification time.
            var expected = S(row, "conditional") switch
            {
                "if-none-match" => jf12 ? 304 : 200,
                "if-modified-since" => 304,
                _ => 200,
            };
            Assert.True(row["status"]!.GetValue<int>() == expected, Describe(row) + " expected " + expected);
            if (expected == 200)
            {
                Assert.True(S(row, "method") == "HEAD" || row["servedImage"]!.GetValue<bool>(), Describe(row));
                Assert.NotNull(row["lastModified"]);
            }

            if (jf12 && tagged && expected == 200) Assert.NotNull(row["etag"]);
        }

        // The positive control for the withheld rows: this harness does reach the host's 304, on both releases.
        Assert.Contains(rows, r => S(r, "conditional") == "if-modified-since" && S(r, "alias") == "path-form" && r["status"]!.GetValue<int>() == 304);
        Assert.Equal(jf12, rows.Any(r => S(r, "conditional") == "if-none-match" && r["status"]!.GetValue<int>() == 304));
    }

    [Fact]
    public void ThePlaylistLibraryTilesTheHostComposesFromListImagesAreWithheldAndOtherLibrariesAreNot()
    {
        var run = LegacyCollageHost.Run();
        foreach (var row in Images(run, r => S(r, "item") is "playlistslibrary" or "playlistsview"))
        {
            Assert.True(row["status"]!.GetValue<int>() == 404 && !row["servedImage"]!.GetValue<bool>(), Describe(row));
        }

        Assert.All(Images(run, r => S(r, "item") == "movieslibrary" && S(r, "conditional") == "none"), r => Assert.Equal(200, r["status"]!.GetValue<int>()));
    }

    [Fact]
    public void ImageInfoListsNoWithheldImageNorItsPathAndKeepsEveryOther()
    {
        var run = LegacyCollageHost.Run();
        var answers = run["answers"]!.AsObject();
        foreach (var name in Withheld.Append("playlistslibrary"))
        {
            var answer = answers["infos:" + name]!.AsObject();
            Assert.Equal(200, answer["status"]!.GetValue<int>());
            var infos = JsonNode.Parse(S(answer, "body"))!.AsArray();
            Assert.DoesNotContain(infos, i => i!["ImageType"]!.GetValue<string>() is "Primary" or "Thumb");
            Assert.DoesNotContain(run["names"]![name]!.GetValue<string>(), S(answer, "body"));
        }

        foreach (var name in Served)
        {
            var infos = JsonNode.Parse(S(answers["infos:" + name]!.AsObject(), "body"))!.AsArray();
            var primary = Assert.Single(infos, i => i!["ImageType"]!.GetValue<string>() == "Primary");
            Assert.Contains(run["names"]![name]!.GetValue<string>(), primary!["Path"]!.GetValue<string>());
            Assert.False(string.IsNullOrEmpty(primary["ImageTag"]?.GetValue<string>()));
        }
    }

    [Fact]
    public void ItemDtosInEveryShapeLoseTheWithheldImagesTagsBlurHashesAndAspectRatioAndKeepTheRest()
    {
        var run = LegacyCollageHost.Run();
        var answers = run["answers"]!.AsObject();
        var names = run["names"]!.AsObject().ToDictionary(p => p.Value!.GetValue<string>(), p => p.Key);
        var dtos = new List<JsonObject>();
        foreach (var name in names.Values) dtos.Add(JsonNode.Parse(S(answers["dto:" + name]!.AsObject(), "body"))!.AsObject());
        dtos.AddRange(JsonNode.Parse(S(answers["query"]!.AsObject(), "body"))!["Items"]!.AsArray().Select(d => d!.AsObject()));
        dtos.AddRange(JsonNode.Parse(S(answers["lazy"]!.AsObject(), "body"))!.AsArray().Select(d => d!.AsObject()));
        dtos.AddRange(JsonNode.Parse(S(answers["recommendations"]!.AsObject(), "body"))![0]!["Items"]!.AsArray().Select(d => d!.AsObject()));
        Assert.Equal(names.Count * 4, dtos.Count);
        foreach (var dto in dtos)
        {
            var name = names[dto["Id"]!.GetValue<string>().Replace("-", string.Empty, StringComparison.Ordinal)];
            var tags = dto["ImageTags"]!.AsObject();
            var hashes = dto["ImageBlurHashes"]?.AsObject();
            if (Withheld.Contains(name) || name is "playlistslibrary" or "playlistsview")
            {
                Assert.False(tags.ContainsKey("Primary"), name);
                Assert.False(tags.ContainsKey("Thumb"), name);
                Assert.False(hashes?.ContainsKey("Primary") == true || hashes?.ContainsKey("Thumb") == true, name);
                Assert.Null(dto["PrimaryImageAspectRatio"]);
                Assert.Null(dto["ParentPrimaryImageItemId"]);
                Assert.Null(dto["ParentPrimaryImageTag"]);
            }
            else
            {
                Assert.True(tags.ContainsKey("Primary"), name);
                Assert.True(hashes!.ContainsKey("Primary"), name);
                Assert.Equal(1.0, dto["PrimaryImageAspectRatio"]!.GetValue<double>());
            }
        }
    }

    [Fact]
    public void SearchHintsCarryNoWithheldPrimaryTagAndKeepEveryOther()
    {
        var run = LegacyCollageHost.Run();
        var answer = run["answers"]!["search"]!.AsObject();
        Assert.Equal(200, answer["status"]!.GetValue<int>());
        var names = run["names"]!.AsObject().ToDictionary(p => p.Value!.GetValue<string>(), p => p.Key);
        var hints = JsonNode.Parse(S(answer, "body"))!["SearchHints"]!.AsArray().Select(h => h!.AsObject()).ToList();
        Assert.Equal(names.Count, hints.Count);
        foreach (var hint in hints)
        {
            var name = names[hint["Id"]!.GetValue<string>().Replace("-", string.Empty, StringComparison.Ordinal)];
            if (Withheld.Contains(name) || name is "playlistslibrary")
            {
                Assert.Null(hint["PrimaryImageTag"]);
                Assert.Null(hint["PrimaryImageAspectRatio"]);
            }
            else if (Served.Contains(name))
            {
                Assert.False(string.IsNullOrEmpty(hint["PrimaryImageTag"]?.GetValue<string>()), name);
            }

            if (name == "playlistsview") Assert.Null(hint["ThumbImageTag"]);
        }
    }

    [Fact]
    public void TheAdminPosterTagPreviewDrawsOnNoWithheldCollage()
    {
        var answers = LegacyCollageHost.Run()["answers"]!.AsObject();
        foreach (var name in Withheld)
        {
            Assert.Equal(404, answers["preview:" + name]!["status"]!.GetValue<int>());
            Assert.Contains("Item has no Primary image.", S(answers["preview:" + name]!.AsObject(), "body"));
        }

        foreach (var name in new[] { "custom", "unrelated", "unrelatedset" }) Assert.Equal(200, answers["preview:" + name]!["status"]!.GetValue<int>());
    }
}
