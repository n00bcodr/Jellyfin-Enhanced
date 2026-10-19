using System.Reflection;
// Every controller action of a Jellyfin host (Jellyfin.Api.dll, loaded by metadata only) with its declared
// response type and whether that type can carry a title (BaseItemDto, SearchHint, ImageInfo, MediaSourceInfo,
// RecommendationDto, an ActivityLogEntry, whose text names the item it records by ItemId, or a SeriesTimerInfoDto, whose
// Name and Overview are the programme it records), found by walking properties and generic arguments.
// Usage: dotnet run --project tests/host/endpoint-registry -- <dir with host assemblies>
// → TSV: Controller, Action, routes, declared type, title path (empty = none)
var dir = args[0];
var paths = Directory.GetFiles(dir, "*.dll");
using var ctx = new MetadataLoadContext(new PathAssemblyResolver(paths));
var api = ctx.LoadFromAssemblyPath(Path.Combine(dir, "Jellyfin.Api.dll"));
var atoms = new HashSet<string> { "BaseItemDto", "SearchHint", "ImageInfo", "MediaSourceInfo", "RecommendationDto", "ActivityLogEntry", "SeriesTimerInfoDto" };
var memo = new Dictionary<Type, string?>();
string Name(Type t) => t.IsGenericType ? t.Name.Split('`')[0] + "<" + string.Join(",", t.GetGenericArguments().Select(Name)) + ">" : t.IsArray ? Name(t.GetElementType()!) + "[]" : t.Name;
string? TitlePath(Type t, int depth)
{
    if (atoms.Contains(t.Name) && t.Namespace?.StartsWith("MediaBrowser") == true) return t.Name;
    if (depth > 6 || t.IsPrimitive || t.IsEnum || t.Namespace is "System" && !t.IsGenericType) return null;
    if (memo.TryGetValue(t, out var hit)) return hit;
    memo[t] = null;
    string? found = null;
    if (t.IsArray) found = TitlePath(t.GetElementType()!, depth + 1);
    if (found == null && t.IsGenericType)
        foreach (var a in t.GetGenericArguments()) if ((found = TitlePath(a, depth + 1)) != null) break;
    if (found == null && t.Namespace?.StartsWith("System") != true)
        foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            if (TitlePath(p.PropertyType, depth + 1) is { } inner) { found = t.Name + "." + p.Name + ":" + inner; break; }
    memo[t] = found;
    return found;
}
Type Unwrap(Type t)
{
    while (t.IsGenericType && t.Name.Split('`')[0] is "Task" or "ValueTask" or "ActionResult" or "IAsyncEnumerable")
        t = t.GetGenericArguments()[0];
    return t;
}
foreach (var type in api.GetTypes().Where(t => t.Name.EndsWith("Controller") && !t.IsAbstract).OrderBy(t => t.Name))
foreach (var m in type.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly).OrderBy(m => m.Name))
{
    var attrs = m.GetCustomAttributesData();
    var verbs = attrs.Where(a => a.AttributeType.Name.StartsWith("Http") && a.AttributeType.Name.EndsWith("Attribute"))
        .Select(a => a.AttributeType.Name.Replace("Attribute", "") + "(" + string.Join(",", a.ConstructorArguments.Select(x => x.Value)) + ")").ToArray();
    if (verbs.Length == 0) continue;
    var declared = Unwrap(m.ReturnType);
    var produced = attrs.Where(a => a.AttributeType.Name == "ProducesResponseTypeAttribute")
        .SelectMany(a => a.ConstructorArguments).Where(x => x.Value is Type).Select(x => (Type)x.Value!).ToArray();
    var path = TitlePath(declared, 0) ?? produced.Select(p => TitlePath(p, 0)).FirstOrDefault(p => p != null);
    var c = type.Name[..^"Controller".Length];
    Console.WriteLine($"{c}\t{m.Name}\t{string.Join(" ", verbs)}\t{Name(declared)}\t{path}");
}
