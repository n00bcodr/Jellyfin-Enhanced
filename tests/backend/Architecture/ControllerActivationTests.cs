using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller;
using Microsoft.Extensions.DependencyInjection;
using Moq;
using Xunit.Abstractions;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Platform;

namespace JE.Tests.Architecture;

// R5 (artifacts/restructure-plan/backend.md §6): MVC activates controllers per request, so a moved controller whose
// constructor asks for an unregistered plugin service would only fail at request time. This builds the plugin's own
// ServiceCollection (PluginServiceRegistrator) plus host fakes and constructs every controller type with
// ActivatorUtilities. Host fakes are generated only for types from outside the plugin assembly (Jellyfin and
// framework interfaces); a missing PLUGIN registration is never faked, so it fails here.
[Collection("Plugin singleton")]
public class ControllerActivationTests(ITestOutputHelper output)
{
    private static bool Registered(IServiceCollection services, Type type)
        => type.IsGenericType && type.GetGenericTypeDefinition() == typeof(IEnumerable<>)
           || services.Any(d => d.ServiceType == type || (type.IsGenericType && d.ServiceType == type.GetGenericTypeDefinition()));

    // Moq fake for a host interface or abstract class. Path providers return per-property folders under the fixture root.
    private static object Fake(Type type, string root)
    {
        var mock = (Mock)Activator.CreateInstance(typeof(Mock<>).MakeGenericType(type))!;
        mock.DefaultValue = DefaultValue.Mock;
        var instance = mock.Object;
        if (type.Name.EndsWith("Paths", StringComparison.Ordinal))
        {
            foreach (var property in new[] { type }.Concat(type.GetInterfaces()).SelectMany(t => t.GetProperties()).Where(p => p.PropertyType == typeof(string) && p.CanRead))
            {
                var setup = typeof(ControllerActivationTests).GetMethod(nameof(SetupPath), BindingFlags.NonPublic | BindingFlags.Static)!.MakeGenericMethod(type);
                var folder = Directory.CreateDirectory(Path.Combine(root, property.Name)).FullName;
                setup.Invoke(null, [mock, property, folder]);
            }
        }
        return instance;
    }

    private static void SetupPath<T>(Mock<T> mock, PropertyInfo property, string value) where T : class
    {
        var parameter = System.Linq.Expressions.Expression.Parameter(typeof(T), "p");
        var body = System.Linq.Expressions.Expression.Property(parameter, property);
        mock.SetupGet(System.Linq.Expressions.Expression.Lambda<Func<T, string>>(body, parameter)).Returns(value);
    }

    // Walks the constructors of the controllers and of every registered implementation they reach, and registers a
    // fake for each unregistered dependency that comes from outside the plugin assembly.
    internal static List<Type> AddHostFakes(IServiceCollection services, IEnumerable<Type> roots, string root)
    {
        var faked = new List<Type>();
        var seen = new HashSet<Type>();
        var pending = new Queue<Type>(roots);
        while (pending.Count > 0)
        {
            var type = pending.Dequeue();
            // Only plugin types are walked; framework implementations (LoggerFactory, …) resolve their own dependencies.
            if (!seen.Add(type) || type.IsGenericTypeDefinition || type.Assembly != Arch.Plugin) continue;
            foreach (var parameter in type.GetConstructors().SelectMany(c => c.GetParameters()))
            {
                var dependency = parameter.ParameterType;
                if (dependency.IsGenericType && dependency.GetGenericTypeDefinition() == typeof(IEnumerable<>)) dependency = dependency.GetGenericArguments()[0];
                if (!Registered(services, dependency))
                {
                    if (dependency.Assembly == Arch.Plugin || parameter.HasDefaultValue || dependency.IsValueType || dependency == typeof(string)) continue;
                    if (!(dependency.IsInterface || dependency.IsAbstract)) continue;
                    services.AddSingleton(dependency, Fake(dependency, root));
                    faked.Add(dependency);
                    continue;
                }
                foreach (var implementation in services.Where(d => d.ServiceType == dependency).Select(d => d.ImplementationType).OfType<Type>())
                    pending.Enqueue(implementation);
                if (dependency.Assembly == Arch.Plugin && !dependency.IsInterface && !dependency.IsAbstract) pending.Enqueue(dependency);
            }
        }
        return faked;
    }

    [Fact]
    public void EveryControllerResolvesFromThePluginServiceCollection()
    {
        using var plugin = new ApiPluginFixture();
        var services = new ServiceCollection();
        services.AddLogging();
        // Every IApplicationPaths string property points at its own folder under the fixture root.
        services.AddSingleton(typeof(IApplicationPaths), Fake(typeof(IApplicationPaths), plugin.Core.Root));
        var host = new Mock<IServerApplicationHost>();
        host.SetupGet(h => h.ApplicationVersion).Returns(new Version("12.0.0"));
        host.SetupGet(h => h.ApplicationVersionString).Returns("test-host");
        services.AddSingleton(host.Object);
        new PluginServiceRegistrator().RegisterServices(services, host.Object);
        var controllers = Arch.Controllers();
        var faked = AddHostFakes(services, controllers, plugin.Core.Root);
        output.WriteLine($"controllers: {controllers.Length}; host fakes: {string.Join(", ", faked.Select(Arch.Name).OrderBy(n => n, StringComparer.Ordinal))}");
        using var provider = services.BuildServiceProvider(new ServiceProviderOptions { ValidateScopes = true });
        using var scope = provider.CreateScope();
        var failures = new List<string>();
        foreach (var controller in controllers)
        {
            try { Assert.IsAssignableFrom(controller, ActivatorUtilities.CreateInstance(scope.ServiceProvider, controller)); }
            catch (Exception e) { failures.Add($"{controller.Name}: {e}"); }
        }
        foreach (var failure in failures) output.WriteLine(failure);
        Assert.True(controllers.Length >= 2, "expected at least JePlatformController and JeCatchupController");
        Assert.Empty(failures);
    }
}
