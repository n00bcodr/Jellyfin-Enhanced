using System.Collections;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Extensions.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Authentication;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Search;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

// Every answer shape the pinned Jellyfin release's own controllers return that can carry an item DTO or a search hint
// (found by walking Jellyfin.Api.dll's action return types, so a shape a Jellyfin update adds fails here until the
// rewrite handles it) is built holding a withheld list at every place a DTO can sit, lazy sequences included, and must
// come out of the projection, as the host writes them (its JSON settings), with none of that list's Primary image
// left; the same shapes holding a list without a marker keep everything (the walk really reaches the DTOs).
public class ListsLegacyCollageShapesTests : IDisposable
{
    private const string Tag = "0123456789abcdef0123456789abcdef";
    private readonly string _root = Path.Combine(Path.GetTempPath(), "je-legacy-shapes-" + Guid.NewGuid().ToString("N"));
    private readonly Playlist _withheld = new() { Id = Guid.NewGuid(), Name = "legacy" };
    private readonly Playlist _plain = new() { Id = Guid.NewGuid(), Name = "plain" };
    private readonly LegacyCollageWithhold _withhold;

    public ListsLegacyCollageShapesTests()
    {
        var dirs = LegacyCollageWithhold.MarkerDirectories(Path.Combine(_root, "configurations", "Jellyfin.Plugin.JellyfinEnhanced"));
        Directory.CreateDirectory(dirs[0]);
        var image = Path.Combine(_root, "folder.jpg");
        File.WriteAllBytes(image, new byte[] { 0xFF, 0xD8, 1, 2, 3, 0xFF, 0xD9 });
        _withheld.ImageInfos = new[] { new ItemImageInfo { Path = image, Type = ImageType.Primary } };
        _plain.ImageInfos = _withheld.ImageInfos;
        File.WriteAllText(Path.Combine(dirs[0], _withheld.Id.ToString("N") + ".json"), JsonSerializer.Serialize(new { listId = _withheld.Id.ToString("N"), sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(image))).ToLowerInvariant() }));
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(_withheld.Id)).Returns(_withheld);
        library.Setup(l => l.GetItemById(_plain.Id)).Returns(_plain);
        _withhold = new LegacyCollageWithhold(dirs, library.Object);
    }

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private static readonly HashSet<string> Carried = new(StringComparer.Ordinal) { typeof(BaseItemDto).FullName!, typeof(SearchHint).FullName!, typeof(ImageInfo).FullName! };

    private static Type Unwrap(Type t)
    {
        while (t.IsGenericType && t.GetGenericTypeDefinition().FullName is "System.Threading.Tasks.Task`1" or "System.Threading.Tasks.ValueTask`1" or "Microsoft.AspNetCore.Mvc.ActionResult`1")
            t = t.GetGenericArguments()[0];
        return t;
    }

    private static bool Carries(Type t, HashSet<string> seen, int depth = 0)
    {
        if (t.FullName != null && Carried.Contains(t.FullName)) return true;
        if (depth > 6 || t.IsPrimitive || t.IsEnum || t.FullName == "System.String" || !seen.Add(t.FullName ?? t.Name)) return false;
        if (t.IsArray) return Carries(t.GetElementType()!, seen, depth + 1);
        if (t.IsGenericType && t.GetGenericArguments().Any(a => Carries(a, seen, depth + 1))) return true;
        if (t.Namespace?.StartsWith("System", StringComparison.Ordinal) == true || t.Namespace?.StartsWith("Microsoft", StringComparison.Ordinal) == true) return false;
        return t.GetProperties(BindingFlags.Public | BindingFlags.Instance).Any(p => Carries(p.PropertyType, seen, depth + 1)) || (t.BaseType != null && Carries(t.BaseType, seen, depth + 1));
    }

    // The test build's own type for a type read from the release's assembly.
    private static Type Runtime(Type t)
    {
        if (t.IsArray) return Runtime(t.GetElementType()!).MakeArrayType();
        if (t.IsGenericType && !t.IsGenericTypeDefinition) return Runtime(t.GetGenericTypeDefinition()).MakeGenericType(t.GetGenericArguments().Select(Runtime).ToArray());
        _ = typeof(AuthenticationResult);
        return AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(t.FullName!, false)).FirstOrDefault(r => r != null)
            ?? throw new Xunit.Sdk.XunitException("No runtime type for " + t.FullName);
    }

    // Every answer type of the release's controllers that can carry a DTO or hint (image infos are the image route's
    // own case, checked through the real controller in ListsLegacyCollageHostTests).
    private static List<Type> CarrierShapes()
    {
        using var api = JellyfinApiAssembly.Load();
        return api.Actions().Select(a => Unwrap(a.Method.ReturnType)).Where(t => Carries(t, new HashSet<string>()))
            .Select(Runtime).Distinct().Where(t => !typeof(IEnumerable<ImageInfo>).IsAssignableFrom(t)).OrderBy(t => t.FullName, StringComparer.Ordinal).ToList();
    }

    private BaseItemDto Dto(Playlist list, bool withProgramme = true) => new()
    {
        Id = list.Id,
        Type = BaseItemKind.Playlist,
        ImageTags = new Dictionary<ImageType, string> { [ImageType.Primary] = Tag, [ImageType.Backdrop] = "b" },
        ImageBlurHashes = new Dictionary<ImageType, Dictionary<string, string>> { [ImageType.Primary] = new() { [Tag] = "LEHV6nWB2yk8pyo0adR*.7kCMdnj" } },
        PrimaryImageAspectRatio = 1,
        CurrentProgram = withProgramme ? Dto(list, withProgramme: false) : null,
    };

    private object? Build(Type t, Playlist list, int depth = 0)
    {
        if (t == typeof(BaseItemDto)) return Dto(list);
        if (t == typeof(SearchHint)) return new SearchHint { Id = list.Id, Type = BaseItemKind.Playlist, PrimaryImageTag = Tag, PrimaryImageAspectRatio = 1 };
        if (depth > 4 || !Carries(t, new HashSet<string>())) return null;
        if (t.IsArray)
        {
            var array = Array.CreateInstance(t.GetElementType()!, 2);
            array.SetValue(Build(t.GetElementType()!, list, depth + 1), 0);
            array.SetValue(Build(t.GetElementType()!, list, depth + 1), 1);
            return array;
        }

        if (t.IsGenericType && t.IsInterface)
        {
            var element = t.GetGenericArguments()[0];
            // A bare IEnumerable is lazy (a fresh element on every enumeration, as host projections are); the others are lists.
            if (t.GetGenericTypeDefinition() == typeof(IEnumerable<>))
                return GetType().GetMethod(nameof(Lazy), BindingFlags.NonPublic | BindingFlags.Static)!.MakeGenericMethod(element).Invoke(null, new object[] { (Func<object?>)(() => Build(element, list, depth + 1)) });
            var listType = typeof(List<>).MakeGenericType(element);
            var items = (IList)Activator.CreateInstance(listType)!;
            items.Add(Build(element, list, depth + 1));
            return items;
        }

        // The parameterless constructor, else the one taking the most (carrying parameters built, the rest defaults).
        var constructor = t.GetConstructor(Type.EmptyTypes) ?? t.GetConstructors().OrderByDescending(c => c.GetParameters().Length).First();
        var instance = constructor.Invoke(constructor.GetParameters()
            .Select(p => Carries(p.ParameterType, new HashSet<string>()) ? Build(p.ParameterType, list, depth + 1) : p.ParameterType.IsValueType ? Activator.CreateInstance(p.ParameterType) : null).ToArray());
        foreach (var property in t.GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(p => p.CanWrite && Carries(p.PropertyType, new HashSet<string>())))
            property.SetValue(instance, Build(property.PropertyType, list, depth + 1));
        return instance;
    }

    private static IEnumerable<T> Lazy<T>(Func<object?> make)
    {
        yield return (T)make()!;
        yield return (T)make()!;
    }

    // Every object in the answer's JSON that names the list (DTOs and hints alike), after the projection.
    private List<JsonObject> Projected(Type shape, Playlist list)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(Build(shape, list), shape, JsonDefaults.PascalCaseOptions);
        var outcome = LegacyCollageProjection.Project(json, _withhold.Begin(), out var projected);
        Assert.NotEqual(LegacyCollageProjected.NotJson, outcome);
        var found = new List<JsonObject>();
        void Walk(JsonNode? node)
        {
            switch (node)
            {
                case JsonObject o:
                    if (o["Id"] is JsonValue id && Guid.TryParse(id.GetValue<string>(), out var g) && g == list.Id) found.Add(o);
                    foreach (var child in o.Select(p => p.Value).ToList()) Walk(child);
                    break;
                case JsonArray a:
                    foreach (var child in a) Walk(child);
                    break;
            }
        }

        Walk(JsonNode.Parse(projected ?? json));
        Assert.True(found.Count > 0, shape + ": the walk found no DTO");
        return found;
    }

    [Fact]
    public void TheReleaseHasTheAnswerShapesThisTestKnowsAbout()
    {
        // Not the assertion that matters (the next test covers whatever is found); a visible count when Jellyfin changes.
        var shapes = CarrierShapes();
        Assert.Contains(typeof(BaseItemDto), shapes);
        Assert.Contains(typeof(SearchHintResult), shapes);
        Assert.Contains(typeof(MediaBrowser.Model.Querying.QueryResult<BaseItemDto>), shapes);
        Assert.InRange(shapes.Count, 8, 40);
    }

    [Fact]
    public void EveryHostAnswerShapeLosesAWithheldListsPrimaryWhereverItsDtosSit()
    {
        foreach (var shape in CarrierShapes())
        {
            foreach (var found in Projected(shape, _withheld))
            {
                Assert.Null(found["PrimaryImageTag"]);
                Assert.Null(found["PrimaryImageAspectRatio"]);
                if (found["ImageTags"] is JsonObject tags)
                {
                    Assert.False(tags.ContainsKey("Primary"), shape.ToString());
                    Assert.True(tags.ContainsKey("Backdrop"), shape.ToString());
                    Assert.False(found["ImageBlurHashes"]!.AsObject().ContainsKey("Primary"), shape.ToString());
                }
            }
        }
    }

    [Fact]
    public void TheSameShapesHoldingAListWithoutAMarkerKeepEverything()
    {
        foreach (var shape in CarrierShapes())
        {
            foreach (var found in Projected(shape, _plain))
            {
                if (found["ImageTags"] is JsonObject tags)
                {
                    Assert.Equal(Tag, tags["Primary"]!.GetValue<string>());
                    Assert.True(found["ImageBlurHashes"]!.AsObject().ContainsKey("Primary"));
                    Assert.Equal(1, found["PrimaryImageAspectRatio"]!.GetValue<double>());
                }
                else
                {
                    Assert.Equal(Tag, found["PrimaryImageTag"]!.GetValue<string>());
                }
            }
        }
    }
}
