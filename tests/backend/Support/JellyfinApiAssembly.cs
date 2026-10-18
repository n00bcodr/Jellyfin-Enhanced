using System.Reflection;
using System.Text.Json;

namespace JE.Tests;

/// <summary>
/// Jellyfin's own Jellyfin.Api.dll of the release pinned for this target (Support/jellyfin-api.json: 12.2 for the
/// Jellyfin 12 build, 10.11.11 for the 10.11 one), read with a MetadataLoadContext: its types and methods are real
/// reflection objects, and none of its code is loaded to run. tests/backend/jellyfin_api.py copies it out of the
/// pinned image (tests/run.py backend does that first); JE_JELLYFIN_API names another copy (a newer Jellyfin, say). A
/// missing assembly fails the test that asked for it: the coverage it checks is never assumed.
/// </summary>
internal sealed class JellyfinApiAssembly : IDisposable
{
    private readonly MetadataLoadContext _context;

    private JellyfinApiAssembly(string line, string version, string path)
    {
        Line = line;
        Version = version;
        Path = path;
        // The runtime's and ASP.NET Core's assemblies, then the Jellyfin packages the tests were built with (enough to
        // resolve the controllers' base types and attributes), then the assembly itself.
        var paths = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(System.IO.Path.PathSeparator).Concat(Directory.EnumerateFiles(AppContext.BaseDirectory, "*.dll")))
        {
            var name = System.IO.Path.GetFileNameWithoutExtension(file);
            if (name is "Jellyfin.Api" or "JE.Tests" || paths.ContainsKey(name)) continue;
            paths[name] = file;
        }
        paths["Jellyfin.Api"] = path;
        _context = new MetadataLoadContext(new PathAssemblyResolver(paths.Values));
        Assembly = _context.LoadFromAssemblyPath(path);
    }

    /// <summary>The compatibility line ("jf12" or "jf10").</summary>
    public string Line { get; }

    /// <summary>The pinned release ("12.2").</summary>
    public string Version { get; }

    /// <summary>The assembly file.</summary>
    public string Path { get; }

    /// <summary>The assembly (MetadataLoadContext).</summary>
    public Assembly Assembly { get; }

    /// <summary>The line this test build runs on: .NET 10 is the Jellyfin 12 build, .NET 9 the 10.11 one.</summary>
    public static string CurrentLine => Environment.Version.Major >= 10 ? "jf12" : "jf10";

    /// <summary>Where jellyfin_api.py puts the pinned release's assembly (keep in step with its <c>location</c>).</summary>
    public static (string Version, string Path) Pinned(string line)
    {
        using var pins = JsonDocument.Parse(File.ReadAllText(System.IO.Path.Combine(AppContext.BaseDirectory, "Support", "jellyfin-api.json")));
        var pin = pins.RootElement.GetProperty(line);
        var version = pin.GetProperty("version").GetString()!;
        var digest = pin.GetProperty("image").GetString()!.Split("@sha256:")[1];
        var root = Environment.GetEnvironmentVariable("JE_JELLYFIN_API_CACHE") is { Length: > 0 } cache ? cache
            : System.IO.Path.Combine(Environment.GetEnvironmentVariable("XDG_CACHE_HOME") is { Length: > 0 } xdg ? xdg : System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache"), "jellyfin-enhanced", "jellyfin-api");
        return (version, System.IO.Path.Combine(root, version + "-" + digest[..12], "Jellyfin.Api.dll"));
    }

    /// <summary>The assembly for this build's line; fails (never skips) when it isn't there.</summary>
    public static JellyfinApiAssembly Load()
    {
        var line = CurrentLine;
        var (version, path) = Pinned(line);
        if (Environment.GetEnvironmentVariable("JE_JELLYFIN_API") is { Length: > 0 } other) (version, path) = ("JE_JELLYFIN_API", other);
        if (!File.Exists(path))
            throw new Xunit.Sdk.XunitException("Jellyfin " + version + "'s Jellyfin.Api.dll isn't at " + path + ". Run: python3 tests/backend/jellyfin_api.py --target " + line);
        return new JellyfinApiAssembly(line, version, path);
    }

    /// <summary>One controller action: its controller type, method and HTTP methods ("*": any).</summary>
    public sealed record Action(Type Controller, MethodInfo Method, IReadOnlyList<string> Verbs)
    {
        public string Name => Controller.Name + "." + Method.Name;

        public bool Writes => Verbs.Any(v => v is not ("GET" or "HEAD"));

        public bool HasUserId => Method.GetParameters().Any(p => string.Equals(p.Name, "userId", StringComparison.OrdinalIgnoreCase));
    }

    private static readonly Dictionary<string, string> VerbAttributes = new(StringComparer.Ordinal)
    {
        ["HttpGetAttribute"] = "GET", ["HttpPostAttribute"] = "POST", ["HttpPutAttribute"] = "PUT", ["HttpDeleteAttribute"] = "DELETE",
        ["HttpPatchAttribute"] = "PATCH", ["HttpHeadAttribute"] = "HEAD", ["HttpOptionsAttribute"] = "OPTIONS", ["AcceptVerbsAttribute"] = "*",
    };

    /// <summary>Every action of every controller, as ASP.NET Core finds them: public, non-abstract classes named *Controller
    /// or deriving from ControllerBase; their public instance methods that aren't [NonAction].</summary>
    public IReadOnlyList<Action> Actions()
    {
        Type[] types;
        try { types = Assembly.GetTypes(); }
        catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t != null).ToArray()!; }
        var actions = new List<Action>();
        foreach (var type in types.Where(t => t.IsPublic && t.IsClass && !t.IsAbstract && (t.Name.EndsWith("Controller", StringComparison.Ordinal) || DerivesFromControllerBase(t))))
            foreach (var method in type.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly).Where(m => !m.IsSpecialName))
            {
                var names = Attributes(method);
                if (names.Contains("NonActionAttribute")) continue;
                var verbs = names.Where(VerbAttributes.ContainsKey).Select(n => VerbAttributes[n]).Distinct().OrderBy(v => v, StringComparer.Ordinal).ToList();
                actions.Add(new Action(type, method, verbs.Count == 0 ? new[] { "*" } : verbs));
            }

        return actions;
    }

    private static bool DerivesFromControllerBase(Type type)
    {
        for (var t = type.BaseType; t != null; t = t.BaseType)
            if (t.FullName is "Microsoft.AspNetCore.Mvc.ControllerBase") return true;
        return false;
    }

    // The attribute type names (an attribute whose type can't be resolved here is skipped).
    private static List<string> Attributes(MethodInfo method)
    {
        var names = new List<string>();
        foreach (var data in method.GetCustomAttributesData())
            try { names.Add(data.AttributeType.Name); }
            catch (FileNotFoundException) { }
        return names;
    }

    public void Dispose() => _context.Dispose();
}
