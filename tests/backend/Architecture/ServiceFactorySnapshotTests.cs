using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json;
using MediaBrowser.Controller;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http;
using Microsoft.Extensions.Options;
using Moq;
using Xunit.Abstractions;

namespace JE.Tests.Architecture;

// Registration gate, concrete factories (review M4). service-registrations.snapshot.json writes every factory
// registration as "factory" and every Configure/AddHttpClient options object as "instance:ConfigureNamedOptions<…>",
// so the Seerr HttpClient's handler configuration (redirects, cookies, decompression, the CSRF handler) was not
// verified. This snapshot, keyed by service identity (namespace-free service type) and HttpClient name:
//   factories:   per service type, the sorted list of its factory registrations as "<lifetime> <delegate>";
//   options:     per options type, the sorted list of its Configure/PostConfigure instances as "<name> <delegate>";
//   httpClients: per client name, HttpClientFactoryOptions (handler lifetime, builder and client action counts and
//                targets) and what IHttpMessageHandlerFactory/IHttpClientFactory actually build: the handler chain,
//                the primary handler's settings (and its underlying SocketsHttpHandler's timeouts), the client's.
// A delegate is "<DeclaringType>.<Method>" with captured delegates and simple values in (…) for framework code (the
// same package versions build both trees, so these names are stable). For a plugin lambda the compiler-generated name
// encodes the enclosing method and its ordinal (`<>c.<RegisterServices>b__0_3` at restructure-base,
// `<>c.<AddJeMediaTags>b__0_0` after registrations were grouped by feature), so it is written as "lambda{…}", the
// members its IL references in order, which is what the lambda does. The expected file is generated from a
// restructure-base build (BaseAnchoredSnapshots.cs).
public class ServiceFactorySnapshotTests(ITestOutputHelper output)
{
    public const string SnapshotFile = "service-factories.base.json";

    internal static ServiceCollection Register(Assembly plugin)
    {
        var services = new ServiceCollection();
        var registrator = BaseAnchored.Types(plugin).Single(t => t.Name == "PluginServiceRegistrator" && t.IsClass);
        registrator.GetMethod("RegisterServices")!.Invoke(Activator.CreateInstance(registrator), [services, Mock.Of<IServerApplicationHost>()]);
        return services;
    }

    private static string TypeName(Type? type)
    {
        if (type == null) return "null";
        return type.IsNested && !type.IsGenericParameter ? TypeName(type.DeclaringType) + "+" + Arch.Name(type) : Arch.Name(type);
    }

    private static string MemberName(MemberInfo member) => member switch
    {
        Type type => "type " + TypeName(type),
        MethodInfo { IsGenericMethod: true } m => $"{TypeName(m.DeclaringType)}.{m.Name}<{string.Join(",", m.GetGenericArguments().Select(Arch.Name))}>",
        _ => $"{TypeName(member.DeclaringType)}.{member.Name}",
    };

    private static string? Simple(object? value) => value switch
    {
        null => "null",
        string s => JsonSerializer.Serialize(s, Arch.Json),
        bool or int or long or double or Enum or TimeSpan or Version or Uri => Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture),
        Type t => "typeof " + TypeName(t),
        _ => null,
    };

    // Gate T runs with --collect:"XPlat Code Coverage": coverlet rewrites the plugin's IL and adds calls to its tracker
    // type (namespace Coverlet.Core.Instrumentation.Tracker, named "<assembly>_<guid>"), which are not the plugin's code.
    private static bool IsCoverageTracker(MemberInfo member)
    {
        var type = member as Type ?? member.DeclaringType;
        return type != null && ((type.Namespace?.StartsWith("Coverlet", StringComparison.Ordinal) ?? false)
            || System.Text.RegularExpressions.Regex.IsMatch(type.Name, "_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"));
    }

    internal static string Describe(Delegate? callback, Assembly plugin, int depth = 0)
    {
        if (callback == null) return "null";
        if (callback.GetInvocationList() is { Length: > 1 } list)
            return "[" + string.Join(" + ", list.Select(d => Describe(d, plugin, depth))) + "]";
        var method = callback.Method;
        if (method.DeclaringType?.Assembly == plugin)
            return "lambda{" + string.Join(", ", Arch.IlReferences(method).Where(m => !IsCoverageTracker(m)).Select(MemberName)) + "}";
        var text = new StringBuilder(MemberName(method));
        if (callback.Target != null && depth < 4)
        {
            var captured = new List<string>();
            foreach (var field in callback.Target.GetType().GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).OrderBy(f => f.Name, StringComparer.Ordinal))
            {
                if (field.Name.StartsWith("<>9__", StringComparison.Ordinal)) continue;   // the closure's cached copy of its own lambda
                var value = field.GetValue(callback.Target);
                if (value is Delegate inner) captured.Add($"{field.Name}={Describe(inner, plugin, depth + 1)}");
                else if (Simple(value) is { } simple && value is not null) captured.Add($"{field.Name}={simple}");
            }
            if (captured.Count > 0) text.Append('(').Append(string.Join(", ", captured)).Append(')');
        }
        return text.ToString();
    }

    private static readonly HashSet<string> SkippedProperties = new(StringComparer.Ordinal) { "Properties" };

    // Public readable settings of a handler or client: simple values as text, delegates described, other objects by type.
    private static SortedDictionary<string, string> Settings(object target, Assembly plugin)
    {
        var result = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var property in target.GetType().GetProperties(BindingFlags.Instance | BindingFlags.Public))
        {
            if (!property.CanRead || property.GetIndexParameters().Length > 0 || SkippedProperties.Contains(property.Name)) continue;
            object? value;
            try { value = property.GetValue(target); }
            catch (TargetInvocationException e) { result[property.Name] = "throws " + e.InnerException?.GetType().Name; continue; }
            result[property.Name] = value switch
            {
                Delegate d => Describe(d, plugin),
                _ => Simple(value) ?? "object " + TypeName(value!.GetType()),
            };
        }
        return result;
    }

    internal sealed record ClientEntry(
        string HandlerLifetime, bool SuppressHandlerScope, string[] HandlerBuilderActions, string[] HttpClientActions,
        string ShouldRedactHeaderValue, string[] HandlerChain, SortedDictionary<string, string> PrimaryHandler,
        SortedDictionary<string, string>? UnderlyingHandler, SortedDictionary<string, string> Client);

    internal static string Render(Assembly plugin)
    {
        var services = Register(plugin);
        string Key(ServiceDescriptor d) => ServiceRegistrationSnapshotTests.ServiceKey(d);

        var factories = services
            .Select(d => (d, factory: d.IsKeyedService ? (Delegate?)d.KeyedImplementationFactory : d.ImplementationFactory))
            .Where(p => p.factory != null)
            .GroupBy(p => Key(p.d))
            .OrderBy(g => g.Key, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.Select(p => $"{p.d.Lifetime} {Describe(p.factory, plugin)}").Order(StringComparer.Ordinal).ToArray());

        var options = new SortedDictionary<string, string[]>(StringComparer.Ordinal);
        foreach (var group in services.Where(d => !d.IsKeyedService && d.ImplementationInstance != null).GroupBy(Key))
        {
            var entries = new List<string>();
            foreach (var instance in group.Select(d => d.ImplementationInstance!))
            {
                var type = instance.GetType();
                var action = type.GetProperty("Action")?.GetValue(instance) as Delegate;
                if (action == null) continue;
                var name = type.GetProperty("Name")?.GetValue(instance) as string;
                entries.Add($"{(name == null ? "(all)" : JsonSerializer.Serialize(name, Arch.Json))} {TypeName(type)} {Describe(action, plugin)}");
            }
            if (entries.Count > 0) options[group.Key] = entries.Order(StringComparer.Ordinal).ToArray();
        }

        var names = services
            .Where(d => d.ServiceType == typeof(IConfigureOptions<HttpClientFactoryOptions>) && d.ImplementationInstance is IConfigureNamedOptions<HttpClientFactoryOptions>)
            .Select(d => (string?)d.ImplementationInstance!.GetType().GetProperty("Name")!.GetValue(d.ImplementationInstance) ?? "")
            .Append(Microsoft.Extensions.Options.Options.DefaultName)
            .Distinct().Order(StringComparer.Ordinal).ToList();
        var clients = new SortedDictionary<string, ClientEntry>(StringComparer.Ordinal);
        using (var provider = services.BuildServiceProvider())
        {
            var monitor = provider.GetRequiredService<IOptionsMonitor<HttpClientFactoryOptions>>();
            var handlers = provider.GetRequiredService<IHttpMessageHandlerFactory>();
            var clientFactory = provider.GetRequiredService<IHttpClientFactory>();
            foreach (var name in names)
            {
                var o = monitor.Get(name);
                var chain = new List<string>();
                HttpMessageHandler? handler = handlers.CreateHandler(name);
                var primary = handler;
                for (; handler != null; handler = (handler as DelegatingHandler)?.InnerHandler)
                {
                    chain.Add(TypeName(handler.GetType()));
                    primary = handler;
                }
                var underlying = primary?.GetType().GetField("_underlyingHandler", BindingFlags.Instance | BindingFlags.NonPublic)?.GetValue(primary);
                using var client = clientFactory.CreateClient(name);
                var clientSettings = Settings(client, plugin);
                clientSettings["DefaultRequestHeaders"] = client.DefaultRequestHeaders.ToString().ReplaceLineEndings("\n");
                clients[name] = new ClientEntry(
                    o.HandlerLifetime.ToString(), o.SuppressHandlerScope,
                    o.HttpMessageHandlerBuilderActions.Select(a => Describe(a, plugin)).ToArray(),
                    o.HttpClientActions.Select(a => Describe(a, plugin)).ToArray(),
                    Describe(o.ShouldRedactHeaderValue, plugin),
                    chain.ToArray(),
                    primary == null ? new SortedDictionary<string, string>() : Settings(primary, plugin),
                    underlying == null ? null : Settings(underlying, plugin),
                    clientSettings);
            }
        }

        var json = new JsonSerializerOptions(Arch.Json) { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
        var text = new StringBuilder("{\n  \"factories\": {\n");
        text.Append(string.Join(",\n", factories.Select(p => $"    {JsonSerializer.Serialize(p.Key, Arch.Json)}: {JsonSerializer.Serialize(p.Value, Arch.Json)}")));
        text.Append("\n  },\n  \"options\": {\n");
        text.Append(string.Join(",\n", options.Select(p => $"    {JsonSerializer.Serialize(p.Key, Arch.Json)}: {JsonSerializer.Serialize(p.Value, Arch.Json)}")));
        text.Append("\n  },\n  \"httpClients\": {\n");
        text.Append(string.Join(",\n", clients.Select(p => $"    {JsonSerializer.Serialize(p.Key, Arch.Json)}: {JsonSerializer.Serialize(p.Value, json)}")));
        text.Append("\n  }\n}\n");
        return text.ToString();
    }

    [Fact]
    public void FactoryRegistrationsAndHttpClientsMatchRestructureBase()
    {
        output.WriteLine($"subject: {BaseAnchored.SubjectLabel}");
        var rendered = Render(BaseAnchored.Subject);
        output.WriteLine(rendered);
        BaseAnchored.Verify(SnapshotFile, rendered);
    }

    // The Seerr client's redirect and cookie settings are the reason for this gate (SeerrHttpHelper.NamedClient);
    // spelled out so a regeneration cannot quietly drop them.
    [Fact]
    public void SeerrClientKeepsRedirectsAndCookiesOff()
    {
        var text = Render(BaseAnchored.Subject);
        var line = text.Split('\n').Single(l => l.Contains("SeerrCsrfHandler", StringComparison.Ordinal) && l.Contains("\"handlerChain\"", StringComparison.Ordinal));
        Assert.Contains("\"AllowAutoRedirect\":\"False\"", line);
        Assert.Contains("\"UseCookies\":\"False\"", line);
    }
}
