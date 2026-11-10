using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced;
using MediaBrowser.Controller;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Moq;
using Xunit.Abstractions;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Platform.Services;

namespace JE.Tests.Architecture;

// Registration gate (artifacts/restructure-plan/backend.md §2 "DI registration", §6 R6). RegisterServices runs into a
// bare ServiceCollection and three things are snapshotted:
//   (a) the multiset of (ServiceType, ImplementationType | "factory" | "instance:<type>", Lifetime), sorted, so
//       grouping registrations by feature does not change it;
//   (b) for every ServiceType registered more than once (computed, so it covers IStartupFilter, each
//       IEventConsumer<…>, IHostedService and any future one), the ordered list of its implementations;
//   (c) the resolved MvcOptions.Filters, in order (the Configure<MvcOptions> block is a single entry in (a)).
// Types are written as namespace-free names with generic arguments, so a namespace move leaves the snapshot alone.
// (a) writes factories as "factory" and options objects as "instance:…"; ServiceFactorySnapshotTests (review M4) describes
// them concretely, with the HttpClient handler settings, against restructure-base.
public class ServiceRegistrationSnapshotTests(ITestOutputHelper output)
{
    public const string SnapshotFile = "service-registrations.snapshot.json";

    internal static ServiceCollection Register()
    {
        var services = new ServiceCollection();
        new PluginServiceRegistrator().RegisterServices(services, Mock.Of<IServerApplicationHost>());
        return services;
    }

    internal static string Describe(ServiceDescriptor d)
    {
        object? implementationType = d.IsKeyedService ? d.KeyedImplementationType : d.ImplementationType;
        object? instance = d.IsKeyedService ? d.KeyedImplementationInstance : d.ImplementationInstance;
        object? factory = d.IsKeyedService ? d.KeyedImplementationFactory : d.ImplementationFactory;
        if (implementationType is Type type) return Arch.Name(type);
        if (instance != null) return "instance:" + Arch.Name(instance.GetType());
        return factory != null ? "factory" : "unknown";
    }

    internal static string ServiceKey(ServiceDescriptor d)
        => Arch.Name(d.ServiceType) + (d.IsKeyedService ? $"[key={d.ServiceKey}]" : "");

    internal static string Render(ServiceCollection services)
    {
        var registrations = services.Select(d => $"{ServiceKey(d)} | {Describe(d)} | {d.Lifetime}")
            .OrderBy(line => line, StringComparer.Ordinal).ToList();
        var order = services.GroupBy(ServiceKey).Where(g => g.Count() > 1)
            .OrderBy(g => g.Key, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.Select(Describe).ToArray());
        using var provider = services.BuildServiceProvider();
        var filters = provider.GetRequiredService<IOptions<MvcOptions>>().Value.Filters.Select(f => f switch
        {
            ServiceFilterAttribute service => "service:" + Arch.Name(service.ServiceType),
            TypeFilterAttribute typed => "type:" + Arch.Name(typed.ImplementationType),
            _ => "instance:" + Arch.Name(f.GetType()),
        }).ToList();
        var text = new StringBuilder("{\n  \"registrations\": [\n");
        text.Append(string.Join(",\n", registrations.Select(line => "    " + JsonSerializer.Serialize(line, Arch.Json))));
        text.Append("\n  ],\n  \"multiRegisteredOrder\": {\n");
        text.Append(string.Join(",\n", order.Select(pair => $"    {JsonSerializer.Serialize(pair.Key, Arch.Json)}: {JsonSerializer.Serialize(pair.Value, Arch.Json)}")));
        text.Append("\n  },\n  \"mvcFilters\": ").Append(JsonSerializer.Serialize(filters, Arch.Json)).Append("\n}\n");
        return text.ToString();
    }

    [Fact]
    public void RegistrationsPerTypeOrderAndMvcFiltersMatchTheSnapshot()
    {
        var services = Register();
        var multi = services.GroupBy(ServiceKey).Where(g => g.Count() > 1).ToList();
        output.WriteLine($"registrations: {services.Count}, multi-registered service types: {multi.Count}");
        foreach (var group in multi.OrderBy(g => g.Key, StringComparer.Ordinal))
            output.WriteLine($"  {group.Key}: {string.Join(", ", group.Select(Describe))}");
        Arch.VerifySnapshot(SnapshotFile, Render(services));
    }

    // The four orders backend.md §2 names, spelled out so a snapshot regeneration cannot quietly drop them.
    [Fact]
    public void OrderSensitiveRegistrationsKeepTheirOrder()
    {
        var services = Register();
        string[] Impl<T>() => services.Where(d => d.ServiceType == typeof(T)).Select(Describe).ToArray();
        Assert.Equal(["ScriptInjectionStartupFilter", "BrandingAssetStartupFilter"], Impl<Microsoft.AspNetCore.Hosting.IStartupFilter>());
        Assert.Equal(["MaintenancePlaybackReminderConsumer", "ContinueWatchingPlaybackConsumer", "SpoilerAutoEnableOnFirstPlayConsumer"],
            Impl<MediaBrowser.Controller.Events.IEventConsumer<MediaBrowser.Controller.Library.PlaybackStartEventArgs>>());
        var native = services.Select((d, i) => (d, i)).Where(p => p.d.ServiceType.Name == "NativeStatusRefreshService").Single();
        Assert.Equal(typeof(Microsoft.Extensions.Hosting.IHostedService), services[native.i + 1].ServiceType);
        Assert.Equal("factory", Describe(services[native.i + 1]));
        using var provider = services.BuildServiceProvider();
        Assert.Equal(["HiddenContentResponseFilter", "SpoilerIdentityTagFilter", "SpoilerFieldStripFilter", "PosterTagImageFilter", "SpoilerBlurImageFilter"],
            provider.GetRequiredService<IOptions<MvcOptions>>().Value.Filters.OfType<ServiceFilterAttribute>().Select(f => f.ServiceType.Name));
    }
}
