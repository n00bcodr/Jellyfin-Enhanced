using System.Reflection;
// Every controller action of a Jellyfin host (Jellyfin.Api.dll, loaded by metadata only) with its declared
// response type and whether that type can carry a title (BaseItemDto, SearchHint, ImageInfo, MediaSourceInfo,
// RecommendationDto, an ActivityLogEntry, whose text names the item it records by ItemId, or a SeriesTimerInfoDto, whose
// Name and Overview are the programme it records), found by walking properties and generic arguments.
// Usage: dotnet run --project tests/host/endpoint-registry -- <dir with host assemblies> [--fields]
// → TSV: Controller, Action, routes, declared type, title path (empty = none)
// --fields → TSV: Type, Property, property type, rw|ro (public setter), for every type JE's privacy walker touches in those answers: each
// type on a path to a BaseItemDto (sessions, sign-ins, envelopes, timers), BaseItemDto's own value graph (media
// streams and sources, chapters, people, user data…) and the title rows (timers, series timers, activity entries,
// search hints, recommendation categories). Services/PrivacyFieldClassification.cs must classify every one.
var dir = args[0];
var fields = args.Contains("--fields");
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
var answers = new List<Type>();
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
    if (path != null) answers.Add(declared);
    var c = type.Name[..^"Controller".Length];
    if (!fields) Console.WriteLine($"{c}\t{m.Name}\t{string.Join(" ", verbs)}\t{Name(declared)}\t{path}");
}
if (!fields) return;
// The dashboard's WebSocket "Sessions" message carries the same sessions as the REST answer.
answers.Add(ctx.LoadFromAssemblyPath(Path.Combine(dir, "MediaBrowser.Model.dll")).GetType("MediaBrowser.Model.Dto.SessionInfoDto")
    ?? ctx.LoadFromAssemblyPath(Path.Combine(dir, "MediaBrowser.Controller.dll")).GetType("MediaBrowser.Controller.Session.SessionInfo")!);
bool Host(Type t) => t.Namespace?.StartsWith("MediaBrowser") == true || t.Namespace?.StartsWith("Jellyfin") == true;
IEnumerable<Type> Parts(Type t)
{
    if (t.IsArray) { yield return t.GetElementType()!; yield break; }
    if (t.IsGenericType) foreach (var a in t.GetGenericArguments()) yield return a;
    if (Nullable.GetUnderlyingType(t) is { } u) yield return u;
}
IEnumerable<Type> Props(Type t) => t.GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(p => p.GetIndexParameters().Length == 0).Select(p => p.PropertyType);
var reachMemo = new Dictionary<Type, bool>();
bool Reaches(Type t)
{
    if (t.Name == "BaseItemDto") return true;
    if (reachMemo.TryGetValue(t, out var hit)) return hit;
    reachMemo[t] = false;
    var r = Parts(t).Any(Reaches) || Host(t) && !t.IsEnum && Props(t).Any(Reaches);
    return reachMemo[t] = r;
}
var touched = new SortedDictionary<string, Type>(StringComparer.Ordinal);
var rows = new HashSet<string> { "BaseTimerInfoDto", "TimerInfoDto", "SeriesTimerInfoDto", "ActivityLogEntry", "SearchHint", "SearchHintResult", "RecommendationDto" };
void Containers(Type t, HashSet<Type> seen)
{
    if (!seen.Add(t)) return;
    foreach (var part in Parts(t)) Containers(part, seen);
    if (!Host(t) || t.IsEnum || t.IsArray) return;
    if (Reaches(t) || rows.Contains(t.Name)) touched.TryAdd(Name(t), t);
    if (t.Name == "BaseItemDto") { Graph(t, new HashSet<Type>()); return; }
    if (t.BaseType is { } b && Host(b)) Containers(b, seen);
    foreach (var p in Props(t)) Containers(p, seen);
}
void Graph(Type t, HashSet<Type> seen)
{
    if (!seen.Add(t)) return;
    foreach (var part in Parts(t)) Graph(part, seen);
    if (!Host(t) || t.IsEnum || t.IsArray) return;
    touched.TryAdd(Name(t), t);
    foreach (var p in Props(t)) Graph(p, seen);
}
var visited = new HashSet<Type>();
foreach (var answer in answers) Containers(answer, visited);
foreach (var (name, t) in touched)
    foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(p => p.GetIndexParameters().Length == 0).OrderBy(p => p.Name, StringComparer.Ordinal))
        Console.WriteLine($"{name}\t{p.Name}\t{Name(p.PropertyType)}\t{(p.SetMethod is { IsPublic: true } ? "rw" : "ro")}");
