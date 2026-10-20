#pragma warning disable ASPDEPR004, ASPDEPR008 // TestServer over WebHostBuilder, as the other MVC harnesses here.
using System.Net;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data.Enums;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Search;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace JE.Tests;

/// <summary>
/// Runs the pinned Jellyfin release's own Jellyfin.Api.dll (12.2 for the Jellyfin 12 build, 10.11.11 for the 10.11 one;
/// tests/backend/jellyfin_api.py copies it and the server assemblies next to it out of the official image) as the host
/// would: ImageController and SearchController are the release's real controllers, executed by real ASP.NET Core MVC
/// (routing, model binding, result executors, HEAD, the controller's own ETag/Last-Modified/304 handling), with the
/// plugin's real <c>PluginServiceRegistrator</c> filter chain in front of them. Everything runs in a separate
/// <see cref="AssemblyLoadContext"/> of a child process (Support/TestProgram.cs) that binds the plugin and this test assembly to that release's server
/// assemblies, the way Jellyfin loads a plugin built against older packages. Host services the actions call are
/// fakes (proxies of the release's own interfaces); host services nobody configured get inert proxies. A missing
/// release fails the test, never skips it.
/// </summary>
internal static class LegacyCollageHost
{
    /// <summary>The child-process command (Support/TestProgram.cs).</summary>
    public const string ChildCommand = "legacy-collage-host";

    private static readonly Lazy<string> Results = new(RunInChild);

    /// <summary>The scenario's results (JSON), run once per test process.</summary>
    public static JsonObject Run() => JsonNode.Parse(Results.Value)!.AsObject();

    /// <summary>Where JE_LEGACY_COLLAGE_HOST_REPORT asks for the raw results (evidence for a report), if anywhere.</summary>
    private static void Keep(string results)
    {
        if (Environment.GetEnvironmentVariable("JE_LEGACY_COLLAGE_HOST_REPORT") is { Length: > 0 } path)
            File.WriteAllText(path.Replace("{line}", JellyfinApiAssembly.CurrentLine, StringComparison.Ordinal), results);
    }

    // The host runs in a child process of this same test build, so the second copies of the plugin and this assembly
    // never share the test process (other tests find the plugin by its name) and go away with the child.
    private static string RunInChild()
    {
        var output = Path.Combine(Path.GetTempPath(), "je-legacy-collage-host-" + Guid.NewGuid().ToString("N") + ".json");
        var dotnet = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") is { Length: > 0 } host ? host : "dotnet";
        var start = new System.Diagnostics.ProcessStartInfo(dotnet) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        foreach (var arg in new[] { "exec", Path.Combine(AppContext.BaseDirectory, "JE.Tests.dll"), ChildCommand, output }) start.ArgumentList.Add(arg);
        using var child = System.Diagnostics.Process.Start(start)!;
        var stdout = child.StandardOutput.ReadToEndAsync();
        var stderr = child.StandardError.ReadToEndAsync();
        try
        {
            if (!child.WaitForExit(TimeSpan.FromMinutes(5)))
            {
                child.Kill(entireProcessTree: true);
                throw new Xunit.Sdk.XunitException("The host scenario did not finish in 5 minutes.");
            }

            if (child.ExitCode != 0 || !File.Exists(output))
                throw new Xunit.Sdk.XunitException("The host scenario failed (exit " + child.ExitCode + "): " + stderr.Result + stdout.Result);
            var results = File.ReadAllText(output);
            Keep(results);
            return results;
        }
        finally
        {
            File.Delete(output);
        }
    }

    /// <summary>Runs the scenario in this (child) process and writes its results to <paramref name="output"/>.</summary>
    /// <param name="output">Results file.</param>
    /// <returns>The exit code.</returns>
    public static int RunChild(string output)
    {
        var (version, api) = JellyfinApiAssembly.Pinned(JellyfinApiAssembly.CurrentLine);
        if (!File.Exists(api))
        {
            Console.Error.WriteLine("Jellyfin " + version + "'s server assemblies aren't at " + Path.GetDirectoryName(api) + ". Run: python3 tests/backend/jellyfin_api.py --target " + JellyfinApiAssembly.CurrentLine);
            return 1;
        }

        var context = new HostContext(Path.GetDirectoryName(api)!, AppContext.BaseDirectory);
        var self = context.LoadFromAssemblyName(new AssemblyName(typeof(LegacyCollageHost).Assembly.GetName().Name!));
        var entry = self.GetType(typeof(LegacyCollageHostEntry).FullName!, throwOnError: true)!;
        using (context.EnterContextualReflection())
        {
            try
            {
                File.WriteAllText(output, (string)entry.GetMethod(nameof(LegacyCollageHostEntry.Run))!.Invoke(null, new object[] { version })!);
                return 0;
            }
            catch (TargetInvocationException ex) when (ex.InnerException != null)
            {
                Console.Error.WriteLine("The host scenario failed: " + ex.InnerException);
                return 1;
            }
        }
    }

    // Jellyfin's server assemblies come from the pinned release; the plugin and this test assembly are loaded again
    // here so they bind to them. The runtime, ASP.NET Core and third-party libraries stay shared unless the release
    // needs a newer one than the test build has.
    private sealed class HostContext : AssemblyLoadContext
    {
        private readonly string _server;
        private readonly string _bin;

        public HostContext(string server, string bin) : base("je-legacy-collage-host")
        {
            _server = server;
            _bin = bin;
        }

        protected override Assembly? Load(AssemblyName name)
        {
            var simple = name.Name!;
            if (simple is "JE.Tests" or "Jellyfin.Plugin.JellyfinEnhanced") return LoadFromAssemblyPath(Path.Combine(_bin, simple + ".dll"));
            var server = Path.Combine(_server, simple + ".dll");
            if (!File.Exists(server)) return null;
            if (simple.StartsWith("Jellyfin.", StringComparison.Ordinal) || simple.StartsWith("MediaBrowser.", StringComparison.Ordinal)
                || simple.StartsWith("Emby.", StringComparison.Ordinal) || simple == "jellyfin")
                return LoadFromAssemblyPath(server);
            // Shared unless the test build's copy is older than the release asks for.
            var shared = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
                .FirstOrDefault(p => string.Equals(Path.GetFileNameWithoutExtension(p), simple, StringComparison.OrdinalIgnoreCase));
            if (shared != null && (name.Version == null || AssemblyName.GetAssemblyName(shared).Version >= name.Version)) return null;
            return LoadFromAssemblyPath(server);
        }
    }
}

/// <summary>An inert or scripted proxy of a host interface (the interface's own load context).</summary>
public class LegacyHostFake : DispatchProxy
{
    /// <summary>The script: return a value, or <see cref="Unhandled"/> for the default.</summary>
    public Func<MethodInfo, object?[], object?>? Script { get; set; }

    /// <summary>Marker for "use the default answer".</summary>
    public static readonly object Unhandled = new();

    /// <summary>A proxy of <paramref name="type"/>.</summary>
    public static object Of(Type type, Func<MethodInfo, object?[], object?>? script = null)
    {
        var proxy = Create(type, typeof(LegacyHostFake));
        ((LegacyHostFake)proxy).Script = script;
        return proxy;
    }

    /// <summary>A typed proxy.</summary>
    public static T Of<T>(Func<MethodInfo, object?[], object?>? script = null) where T : class => (T)Of(typeof(T), script);

    /// <inheritdoc />
    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        var answer = Script?.Invoke(method!, args ?? Array.Empty<object?>()) ?? Unhandled;
        return ReferenceEquals(answer, Unhandled) ? Default(method!.ReturnType) : Wrap(method!.ReturnType, answer);
    }

    private static object? Wrap(Type type, object? value)
    {
        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(Task<>) && value is not Task)
            return typeof(Task).GetMethod(nameof(Task.FromResult))!.MakeGenericMethod(type.GetGenericArguments()[0]).Invoke(null, new[] { value });
        return value;
    }

    private static object? Default(Type type)
    {
        if (type == typeof(void)) return null;
        if (type == typeof(Task)) return Task.CompletedTask;
        if (type == typeof(ValueTask)) return default(ValueTask);
        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(Task<>)) return Wrap(type, Default(type.GetGenericArguments()[0]));
        if (type.IsArray) return Array.CreateInstance(type.GetElementType()!, 0);
        if (type.IsGenericType && type.GetGenericTypeDefinition() is var g && (g == typeof(IEnumerable<>) || g == typeof(IReadOnlyList<>) || g == typeof(IReadOnlyCollection<>) || g == typeof(IList<>) || g == typeof(ICollection<>)))
            return Array.CreateInstance(type.GetGenericArguments()[0], 0);
        return type.IsValueType ? Activator.CreateInstance(type) : null;
    }
}

/// <summary>DTO answers in the host's shapes for the response rewrite (the filter keys on shapes, not routes).</summary>
[Route("JeLegacyShapes")]
internal sealed class JeLegacyShapesController(LegacyCollageScenario scenario) : ControllerBase
{
    [HttpGet("Item/{id}")] public ActionResult<BaseItemDto> Item(Guid id) => scenario.Dto(id);
    [HttpGet("Query")] public ActionResult<QueryResult<BaseItemDto>> Query() => new QueryResult<BaseItemDto>(0, scenario.AllIds.Length, scenario.AllIds.Select(scenario.Dto).ToArray());
    // Lazy: a fresh DTO per enumeration, as host projections are.
    [HttpGet("Lazy")] public ActionResult<IEnumerable<BaseItemDto>> Lazy() => Ok(scenario.AllIds.Select(scenario.Dto));
    [HttpGet("Recommendations")] public ActionResult<IEnumerable<RecommendationDto>> Recommendations()
        => Ok(new[] { new RecommendationDto { Items = scenario.AllIds.Select(scenario.Dto).ToArray(), RecommendationType = RecommendationType.SimilarToRecentlyPlayed, BaselineItemName = "x" } }.Select(r => r));
}


/// <summary>The scenario's items and files.</summary>
internal sealed class LegacyCollageScenario
{
    public required string Root { get; init; }
    public required Dictionary<Guid, BaseItem> Items { get; init; }
    public required Dictionary<string, Guid> Names { get; init; }
    public Guid[] AllIds => Names.Values.ToArray();

    public static string Tag(BaseItem item, ItemImageInfo image) => Convert.ToHexString(MD5.HashData(Encoding.UTF8.GetBytes(image.Path + image.DateModified.Ticks))).ToLowerInvariant();

    // What the host's DtoService puts on an item's DTO for its images (tags, blur hashes, aspect).
    public BaseItemDto Dto(Guid id)
    {
        var item = Items[id];
        var dto = new BaseItemDto { Id = id, Name = item.Name, Type = item.GetBaseItemKind(), ImageTags = new Dictionary<ImageType, string>(), ImageBlurHashes = new Dictionary<ImageType, Dictionary<string, string>>() };
        if (item is IHasCollectionType holder) dto.CollectionType = holder.CollectionType;
        foreach (var image in item.ImageInfos)
        {
            var tag = Tag(item, image);
            dto.ImageTags[image.Type] = tag;
            if (image.BlurHash != null) dto.ImageBlurHashes[image.Type] = new Dictionary<string, string> { [tag] = image.BlurHash };
            if (image.Type == ImageType.Primary) dto.PrimaryImageAspectRatio = (double)image.Width / image.Height;
        }

        if (item is UserView { DisplayParentId: var parentId } && Items.TryGetValue(parentId, out var parent) && parent.GetImageInfo(ImageType.Primary, 0) is { } parentImage)
        {
            // The host's playlists view: its tile is the playlists library's image.
            dto.ParentPrimaryImageItemId = parentId;
            dto.ParentPrimaryImageTag = Tag(parent, parentImage);
            dto.ImageBlurHashes.TryAdd(ImageType.Primary, new Dictionary<string, string>());
            dto.ImageBlurHashes[ImageType.Primary][dto.ParentPrimaryImageTag] = parentImage.BlurHash!;
        }

        return dto;
    }
}

/// <summary>The scenario, run inside the host's load context.</summary>
public static class LegacyCollageHostEntry
{
    private const string Blur = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";

    private static readonly (string Name, string Path)[] Aliases =
    {
        ("untagged", "/Items/{0}/Images/{1}"),
        ("tagged", "/Items/{0}/Images/{1}?tag={2}"),
        ("index", "/Items/{0}/Images/{1}/0"),
        ("index-tagged", "/Items/{0}/Images/{1}/0?tag={2}"),
        ("query-index", "/Items/{0}/Images/{1}?imageIndex=0&fillWidth=200&fillHeight=300&quality=90&format=Jpg"),
        ("sized", "/Items/{0}/Images/{1}?maxWidth=300&maxHeight=300&tag={2}"),
        ("path-form", "/Items/{0}/Images/{1}/0/{2}/Jpg/300/300/0/0"),
        ("lowercase", "/Items/{0}/Images/{3}?tag={2}"),
    };

    /// <summary>Runs every request of the scenario and returns what came back (JSON).</summary>
    /// <param name="release">The Jellyfin release (for the report).</param>
    public static string Run(string release)
    {
        var root = Path.Combine(Path.GetTempPath(), "je-legacy-collage-" + Guid.NewGuid().ToString("N"));
        try
        {
            return RunIn(root, release);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch (IOException) { }
        }
    }

    private static string RunIn(string root, string release)
    {
        var scenario = Build(root);
        var before = Snapshot(root);
        var users = new { Viewer = Guid.NewGuid(), Admin = Guid.NewGuid() };
        var report = new JsonObject
        {
            ["release"] = release,
            ["server"] = typeof(BaseItem).Assembly.GetName().Version!.ToString(),
            ["names"] = new JsonObject(scenario.Names.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)p.Value.ToString("N")))),
        };

        using var server = Server(scenario, root);
        using var client = server.CreateClient();
        var requests = new JsonArray();
        foreach (var (name, id) in scenario.Names)
        {
            var item = scenario.Items[id];
            foreach (var image in item.ImageInfos)
            {
                var tag = LegacyCollageScenario.Tag(item, image);
                var sha = Sha(File.ReadAllBytes(image.Path));
                foreach (var (alias, template) in Aliases)
                {
                    var path = string.Format(System.Globalization.CultureInfo.InvariantCulture, template, id.ToString("N"), image.Type, tag, image.Type.ToString().ToLowerInvariant());
                    foreach (var method in new[] { HttpMethod.Get, HttpMethod.Head })
                    {
                        foreach (var (caller, user) in new[] { ("anonymous", (Guid?)null), ("viewer", users.Viewer), ("admin", users.Admin) })
                        {
                            foreach (var conditional in new[] { "none", "if-none-match", "if-modified-since" })
                            {
                                if (conditional == "if-none-match" && !path.Contains(tag, StringComparison.Ordinal)) continue;
                                var request = new HttpRequestMessage(method, path);
                                if (user is { } u) request.Headers.Add("X-Test-User", u.ToString("N") + (caller == "admin" ? ":admin" : string.Empty));
                                if (conditional == "if-none-match") request.Headers.TryAddWithoutValidation("If-None-Match", "\"" + tag + "\"");
                                if (conditional == "if-modified-since") request.Headers.TryAddWithoutValidation("If-Modified-Since", image.DateModified.ToString("R"));
                                var response = client.SendAsync(request).GetAwaiter().GetResult();
                                var body = response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult();
                                requests.Add(new JsonObject
                                {
                                    ["item"] = name,
                                    ["imageType"] = image.Type.ToString(),
                                    ["alias"] = alias,
                                    ["method"] = method.Method,
                                    ["caller"] = caller,
                                    ["conditional"] = conditional,
                                    ["status"] = (int)response.StatusCode,
                                    ["servedImage"] = body.Length > 0 && Sha(body) == sha,
                                    ["etag"] = response.Headers.ETag?.Tag,
                                    ["lastModified"] = response.Content.Headers.LastModified?.ToString("R"),
                                    ["cacheControl"] = response.Headers.CacheControl?.ToString(),
                                    ["contentLength"] = response.Content.Headers.ContentLength,
                                    ["body"] = method == HttpMethod.Get && response.Content.Headers.ContentType?.MediaType?.Contains("json", StringComparison.Ordinal) == true ? Encoding.UTF8.GetString(body) : null,
                                });
                            }
                        }
                    }
                }
            }
        }

        report["images"] = requests;
        var answers = new JsonObject();
        void Answer(string key, string path, Guid? user)
        {
            var request = new HttpRequestMessage(HttpMethod.Get, path);
            if (user is { } u) request.Headers.Add("X-Test-User", u.ToString("N"));
            var response = client.SendAsync(request).GetAwaiter().GetResult();
            answers[key] = new JsonObject { ["status"] = (int)response.StatusCode, ["body"] = response.Content.ReadAsStringAsync().GetAwaiter().GetResult() };
        }

        foreach (var (name, id) in scenario.Names)
        {
            Answer("infos:" + name, "/Items/" + id.ToString("N") + "/Images", users.Viewer);
            Answer("dto:" + name, "/JeLegacyShapes/Item/" + id.ToString("N"), users.Viewer);
            Answer("preview:" + name, "/JellyfinEnhanced/native-poster-tags/preview/" + id.ToString("N"), users.Admin);
        }

        Answer("query", "/JeLegacyShapes/Query", users.Viewer);
        Answer("lazy", "/JeLegacyShapes/Lazy", users.Viewer);
        Answer("recommendations", "/JeLegacyShapes/Recommendations", users.Viewer);
        Answer("search", "/Search/Hints?searchTerm=list", users.Viewer);
        report["answers"] = answers;
        report["filesUnchanged"] = Same(before, Snapshot(root));
        report["filters"] = new JsonArray(server.Services.GetRequiredService<IOptions<MvcOptions>>().Value.Filters
            .Select(f => (JsonNode?)(((f as ServiceFilterAttribute)?.ServiceType ?? f.GetType()).Name + "@" + ((f as IOrderedFilter)?.Order ?? 0))).ToArray());
        return report.ToJsonString();
    }

    // Marker folders exactly where the importer and #936 keep them; images where the host keeps list images.
    private static LegacyCollageScenario Build(string root)
    {
        var pluginDir = Path.Combine(root, "plugins", "configurations", "Jellyfin.Plugin.JellyfinEnhanced");
        var copied = Path.Combine(pluginDir, "lists", "legacy-collages");
        var original = Path.Combine(pluginDir, "list-placeholders", "collages");
        Directory.CreateDirectory(copied);
        Directory.CreateDirectory(original);
        var items = new Dictionary<Guid, BaseItem>();
        var names = new Dictionary<string, Guid>(StringComparer.Ordinal);

        T Add<T>(string name, T item, params (ImageType Type, byte Seed)[] images) where T : BaseItem
        {
            item.Id = Guid.NewGuid();
            item.Name = name + " list";
            var dir = Path.Combine(root, "metadata", item.Id.ToString("N"));
            Directory.CreateDirectory(dir);
            item.ImageInfos = images.Select(i =>
            {
                var path = Path.Combine(dir, i.Type.ToString().ToLowerInvariant() + ".jpg");
                File.WriteAllBytes(path, Image(i.Seed));
                File.SetLastWriteTimeUtc(path, new DateTime(2025, 6, 1, 0, 0, 0, DateTimeKind.Utc));
                return new ItemImageInfo { Path = path, Type = i.Type, DateModified = File.GetLastWriteTimeUtc(path), Width = 600, Height = 600, BlurHash = Blur };
            }).ToArray();
            items[item.Id] = item;
            names[name] = item.Id;
            return item;
        }

        string Marker(BaseItem list, string? sha, string? pending, string? path = null) => JsonSerializer.Serialize(new Dictionary<string, object?>
        {
            ["listId"] = list.Id.ToString("N"),
            ["imagePath"] = sha == null ? string.Empty : path ?? list.ImageInfos[0].Path,
            ["sha256"] = sha ?? string.Empty,
            ["posterKeys"] = new[] { "/a.jpg", "/b.jpg" },
            ["failedKeys"] = Array.Empty<string>(),
            ["setAt"] = sha == null ? string.Empty : "2025-06-01T00:00:00.0000000Z",
            ["pendingSha256"] = pending,
            ["pendingPosterKeys"] = pending == null ? null : new[] { "/a.jpg" },
        });

        string ShaOf(BaseItem item) => Sha(File.ReadAllBytes(item.ImageInfos[0].Path));

        // The #936 shape: the importer's copy of a recorded collage.
        var legacy = Add("legacy", new Playlist(), (ImageType.Primary, 1));
        File.WriteAllText(Path.Combine(copied, legacy.Id.ToString("N") + ".json"), Marker(legacy, ShaOf(legacy), null));
        // Never imported: #936's own marker, a write recorded as pending only (the file landed, the record didn't).
        var pending = Add("pending", new BoxSet(), (ImageType.Primary, 2));
        File.WriteAllText(Path.Combine(original, pending.Id.ToString("N") + ".json"), Marker(pending, null, ShaOf(pending)));
        // A marker JE can't read: treated as the collage.
        var corrupt = Add("corrupt", new Playlist(), (ImageType.Primary, 3));
        File.WriteAllText(Path.Combine(copied, corrupt.Id.ToString("N") + ".json"), "{\"listId\":\"" + corrupt.Id.ToString("N") + "\",\"sha256\":\"\\uD800");
        // The owner set an image after the collage: the marker's hash is the old collage's, not this one's.
        var custom = Add("custom", new Playlist(), (ImageType.Primary, 4));
        File.WriteAllText(Path.Combine(copied, custom.Id.ToString("N") + ".json"), Marker(custom, Sha(Image(99)), null));
        File.WriteAllText(Path.Combine(original, custom.Id.ToString("N") + ".json"), Marker(custom, Sha(Image(98)), null));
        // No marker at all.
        Add("unrelated", new Playlist(), (ImageType.Primary, 5));
        Add("unrelatedset", new BoxSet(), (ImageType.Primary, 6));
        // Library tiles the host composes from list images, and one it doesn't.
        var library = Add("playlistslibrary", new CollectionFolder { CollectionType = CollectionType.playlists }, (ImageType.Primary, 7), (ImageType.Thumb, 8));
        Add("playlistsview", new UserView { ViewType = CollectionType.playlists, DisplayParentId = library.Id }, (ImageType.Thumb, 9));
        Add("movieslibrary", new CollectionFolder { CollectionType = CollectionType.movies }, (ImageType.Primary, 10));
        return new LegacyCollageScenario { Root = root, Items = items, Names = names };
    }

    private static TestServer Server(LegacyCollageScenario scenario, string root)
    {
        var api = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a => a.GetName().Name == "Jellyfin.Api" && AssemblyLoadContext.GetLoadContext(a) == AssemblyLoadContext.GetLoadContext(typeof(LegacyCollageHostEntry).Assembly))
            ?? AssemblyLoadContext.GetLoadContext(typeof(LegacyCollageHostEntry).Assembly)!.LoadFromAssemblyName(new AssemblyName("Jellyfin.Api"));
        var controllers = new[] { api.GetType("Jellyfin.Api.Controllers.ImageController", true)!, api.GetType("Jellyfin.Api.Controllers.SearchController", true)!, typeof(JeLegacyShapesController), typeof(LegacyCollageStandIns.JellyfinEnhancedController) };
        var paths = Paths(root);
        var library = Library(scenario);
        BaseItem.LibraryManager = library;
        var inert = new List<Type>();
        // Host services nobody configured: an inert proxy each, found by resolving the registered filter chain.
        for (var round = 0; ; round++)
        {
            var services = new ServiceCollection();
            Configure(services, scenario, paths, library, inert, controllers, api);
            using var provider = services.BuildServiceProvider();
            var missing = Missing(provider, controllers);
            if (missing == null) break;
            if (round > 200 || inert.Contains(missing) || !missing.IsInterface) throw new InvalidOperationException("Can't stand in for " + missing.FullName);
            inert.Add(missing);
        }

        return new TestServer(new WebHostBuilder()
            .ConfigureServices(services => Configure(services, scenario, paths, library, inert, controllers, api))
            .Configure(app =>
            {
                app.UseRouting();
                app.UseAuthentication();
                app.UseAuthorization();
                app.UseEndpoints(e => e.MapControllers());
            }));
    }

    private static void Configure(IServiceCollection services, LegacyCollageScenario scenario, IServerApplicationPaths paths, ILibraryManager library, List<Type> inert, Type[] controllers, Assembly api)
    {
        services.AddLogging();
        services.AddRouting();
        services.AddAuthentication("test").AddScheme<AuthenticationSchemeOptions, TestUser>("test", _ => { });
        services.AddAuthorization();
        services.AddSingleton(scenario);
        services.AddSingleton<IApplicationPaths>(paths);
        services.AddSingleton(paths);
        services.AddSingleton(library);
        services.AddSingleton(ImageProcessor(scenario));
        services.AddSingleton(LegacyHostFake.Of<IFileSystem>((m, a) => m.Name == "GetFileInfo" ? new FileSystemMetadata { FullName = (string)a[0]!, Exists = File.Exists((string)a[0]!), Length = new FileInfo((string)a[0]!).Length } : LegacyHostFake.Unhandled));
        services.AddSingleton(LegacyHostFake.Of<IDtoService>((m, a) => m.Name == "GetPrimaryImageAspectRatio" ? 1.0 : LegacyHostFake.Unhandled));
        // 12.2 asks for an ISearchManager, 10.11.11 for an ISearchEngine: whatever the release's controller takes.
        var search = controllers[1].GetConstructors().Single().GetParameters()[0].ParameterType;
        services.AddSingleton(search, LegacyHostFake.Of(search, (m, a) => m.Name.StartsWith("GetSearchHints", StringComparison.Ordinal)
            ? new QueryResult<SearchHintInfo>(0, scenario.Items.Count, scenario.Items.Values.Select(i => new SearchHintInfo { Item = i, MatchedTerm = "list" }).ToArray())
            : LegacyHostFake.Unhandled));
        foreach (var type in inert) services.AddSingleton(type, LegacyHostFake.Of(type));
        services.AddSingleton(LegacyHostFake.Of<IServerApplicationHost>());

        // The plugin's own registrations, minus what would start running on its own (startup filters, hosted workers).
        var plugin = new Jellyfin.Plugin.JellyfinEnhanced.PluginServiceRegistrator();
        var pluginServices = new ServiceCollection();
        plugin.RegisterServices(pluginServices, LegacyHostFake.Of<IServerApplicationHost>());
        foreach (var descriptor in pluginServices.Where(d => d.ServiceType != typeof(IHostedService) && d.ServiceType != typeof(IStartupFilter))) services.Add(descriptor);

        var mvc = services.AddControllers().ConfigureApplicationPartManager(parts =>
        {
            parts.ApplicationParts.Clear();
            parts.ApplicationParts.Add(new AssemblyPart(api));
            parts.ApplicationParts.Add(new AssemblyPart(typeof(LegacyCollageHostEntry).Assembly));
            foreach (var provider in parts.FeatureProviders.OfType<ControllerFeatureProvider>().ToList()) parts.FeatureProviders.Remove(provider);
            parts.FeatureProviders.Add(new Only(controllers));
        });
        // The host's own JSON settings (PascalCase, enums as names, its converters).
        mvc.AddJsonOptions(o =>
        {
            o.JsonSerializerOptions.PropertyNamingPolicy = null;
            foreach (var converter in Jellyfin.Extensions.Json.JsonDefaults.PascalCaseOptions.Converters) o.JsonSerializerOptions.Converters.Add(converter);
        });
    }

    // The first host service a registered MVC filter or a controller can't be built without, or null when all resolve.
    private static Type? Missing(IServiceProvider provider, Type[] controllers)
    {
        var needed = provider.GetRequiredService<IOptions<MvcOptions>>().Value.Filters.OfType<ServiceFilterAttribute>().Select(f => f.ServiceType)
            .Concat(controllers.SelectMany(c => c.GetConstructors().Single().GetParameters().Select(p => p.ParameterType)).Where(t => t != typeof(LegacyCollageScenario)));
        foreach (var service in needed)
        {
            try
            {
                provider.GetRequiredService(service);
            }
            catch (InvalidOperationException ex)
            {
                var message = ex.Message;
                var match = System.Text.RegularExpressions.Regex.Match(message, "(?:Unable to resolve service for type|No service for type) '([^']+)'");
                if (!match.Success) throw;
                var name = match.Groups[1].Value;
                return AppDomain.CurrentDomain.GetAssemblies()
                    .Where(a => AssemblyLoadContext.GetLoadContext(a) == AssemblyLoadContext.GetLoadContext(typeof(LegacyCollageHostEntry).Assembly) || AssemblyLoadContext.GetLoadContext(a) == AssemblyLoadContext.Default)
                    .OrderBy(a => AssemblyLoadContext.GetLoadContext(a) == AssemblyLoadContext.Default ? 1 : 0)
                    .Select(a => a.GetType(name.Split('[')[0], false)).FirstOrDefault(t => t != null)
                    ?? throw new InvalidOperationException("Unknown service " + name, ex);
            }
        }

        return null;
    }

    private static ILibraryManager Library(LegacyCollageScenario scenario) => LegacyHostFake.Of<ILibraryManager>((m, a) => m.Name switch
    {
        "GetItemById" when a.Length >= 1 && a[0] is Guid id => scenario.Items.TryGetValue(id, out var item) ? item : null,
        _ => LegacyHostFake.Unhandled,
    });

    // The host processes images into its cache; here the original is the processed file (no resize needed), as the host
    // answers when the requested size and format match the source.
    private static IImageProcessor ImageProcessor(LegacyCollageScenario scenario) => LegacyHostFake.Of<IImageProcessor>((m, a) => m.Name switch
    {
        "ProcessImage" => ((Func<object>)(() =>
        {
            var options = (ImageProcessingOptions)a[0]!;
            return (options.Image.Path, (string?)"image/jpeg", File.GetLastWriteTimeUtc(options.Image.Path));
        }))(),
        "GetImageCacheTag" when a.Length == 2 && a[0] is BaseItem item && a[1] is ItemImageInfo image => LegacyCollageScenario.Tag(item, image),
        "GetImageCacheTag" when a.Length == 2 && a[0] is BaseItem item && a[1] is ImageType type => item.GetImageInfo(type, 0) is { } image ? LegacyCollageScenario.Tag(item, image) : null,
        _ => LegacyHostFake.Unhandled,
    });

    private static IServerApplicationPaths Paths(string root)
    {
        string Dir(string name)
        {
            var dir = Path.Combine(root, name);
            Directory.CreateDirectory(dir);
            return dir;
        }

        return LegacyHostFake.Of<IServerApplicationPaths>((m, a) => m.Name switch
        {
            "get_PluginsPath" => Dir("plugins"),
            "get_PluginConfigurationsPath" => Dir(Path.Combine("plugins", "configurations")),
            "get_LogDirectoryPath" => Dir("log"),
            "get_CachePath" or "get_TempDirectory" or "get_ImageCachePath" => Dir("cache"),
            _ when m.ReturnType == typeof(string) => Dir("data"),
            _ => LegacyHostFake.Unhandled,
        });
    }

    private static byte[] Image(byte seed)
    {
        // A real JPEG start and end around distinct content (the host doesn't decode it here).
        var bytes = new byte[2048];
        new Random(seed).NextBytes(bytes);
        bytes[0] = 0xFF; bytes[1] = 0xD8; bytes[^2] = 0xFF; bytes[^1] = 0xD9;
        return bytes;
    }

    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static Dictionary<string, (string Sha, DateTime Mtime)> Snapshot(string root) => Directory.EnumerateFiles(Path.Combine(root, "metadata"), "*", SearchOption.AllDirectories)
        .Concat(Directory.EnumerateFiles(Path.Combine(root, "plugins", "configurations", "Jellyfin.Plugin.JellyfinEnhanced"), "*.json", SearchOption.AllDirectories))
        .ToDictionary(f => f, f => (Sha(File.ReadAllBytes(f)), File.GetLastWriteTimeUtc(f)), StringComparer.Ordinal);

    private static bool Same(Dictionary<string, (string Sha, DateTime Mtime)> a, Dictionary<string, (string Sha, DateTime Mtime)> b)
        => a.Count == b.Count && a.All(p => b.TryGetValue(p.Key, out var v) && v == p.Value);

    private sealed class Only(Type[] controllers) : IApplicationFeatureProvider<ControllerFeature>
    {
        public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature)
        {
            foreach (var type in controllers) feature.Controllers.Add(type.GetTypeInfo());
        }
    }

    // "X-Test-User: <id>[:admin]" signs in as that Jellyfin user (the claims Jellyfin's own handler sets); none is anonymous.
    private sealed class TestUser(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
        : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
    {
        protected override Task<AuthenticateResult> HandleAuthenticateAsync()
        {
            if (!Request.Headers.TryGetValue("X-Test-User", out var value)) return Task.FromResult(AuthenticateResult.NoResult());
            var parts = value.ToString().Split(':');
            var claims = new List<Claim> { new("Jellyfin-UserId", parts[0]), new(ClaimTypes.Name, "user"), new(ClaimTypes.Role, parts.Length > 1 ? "Administrator" : "User") };
            return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(claims, "test")), "test")));
        }
    }
}
