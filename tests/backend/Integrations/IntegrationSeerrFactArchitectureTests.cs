using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;

namespace JE.Tests;

public class IntegrationSeerrFactArchitectureTests
{
    private const BindingFlags Declared = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
    private static Assembly Plugin => typeof(JellyfinEnhancedController).Assembly;
    private static bool Inside(Type? type, Type owner)
    {
        for (; type != null; type = type.DeclaringType) if (type == owner) return true;
        return false;
    }
    private static bool Contains(Type type, HashSet<Type> forbidden)
        => forbidden.Contains(type) || (type.HasElementType && Contains(type.GetElementType()!, forbidden)) || type.GetGenericArguments().Any(t => Contains(t, forbidden));

    [Fact]
    public void OnlyTheAccessorCanReferenceThePrivateSeerrReadersModelsAndCaches()
    {
        var owner = Plugin.GetType("Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts");
        Assert.NotNull(owner);
        var raw = Plugin.GetTypes().Where(t => t.Name is "SeerrRequestReadModel" or "SeerrMigrationReader" or "SeerrAskedProofCache" or "SeerrOwnershipReader").ToHashSet();
        Assert.Equal(4, raw.Count);
        Assert.All(raw, type => { Assert.True(type.IsNestedPrivate, type.FullName); Assert.True(Inside(type, owner), type.FullName); });
        // Include all raw readers' nested snapshots/cache records, and all signatures and IL bodies,
        // including compiler-generated lambdas and async state machines. No consumer allowlist.
        var forbidden = Plugin.GetTypes().Where(t => raw.Any(r => Inside(t, r))).ToHashSet();
        var violations = new List<string>();
        foreach (var type in Plugin.GetTypes().Where(t => !Inside(t, owner)))
        {
            foreach (var field in type.GetFields(Declared))
                if (Contains(field.FieldType, forbidden)) violations.Add(type.FullName + "." + field.Name);
            foreach (var method in type.GetMethods(Declared).Cast<MethodBase>().Concat(type.GetConstructors(Declared)))
            {
                if (method.GetParameters().Any(p => Contains(p.ParameterType, forbidden)) || method is MethodInfo info && Contains(info.ReturnType, forbidden)) violations.Add(type.FullName + "." + method.Name + " signature");
                foreach (var reference in PrivacyOutputPathScan.Referenced(method))
                    if (reference.DeclaringType != null && Contains(reference.DeclaringType, forbidden)) violations.Add(type.FullName + "." + method.Name + " -> " + reference);
            }
        }
        Assert.Empty(violations);
        // A raw implementation must not escape through a public interface/object return either.
        foreach (var method in owner.GetMethods(Declared).Where(m => !m.IsPrivate && raw.Any(r => m.ReturnType.IsAssignableFrom(r))))
            Assert.DoesNotContain(PrivacyOutputPathScan.Referenced(method), reference =>
                reference is FieldInfo field && Contains(field.FieldType, forbidden) || reference.DeclaringType != null && forbidden.Contains(reference.DeclaringType));
        // Effect owners retain admission through their whole operation, including sources reached through interfaces.
        foreach (var (typeName, methodName) in new[]
        {
            ("Notify.NotificationService", "TickAsync"), ("Notify.NotificationService", "EvaluateAsync"),
            ("Notify.NotifyDispatcher", "RunOnceAsync"), ("Ready.ReadyPlaylistService", "ReconcileLockedAsync"),
            ("Stamps.AcquisitionStampFeeder", "TickAsync"), ("Stamps.AcquisitionStampFeeder", "Judge"),
            ("Requests.FutureSeasonCharges", "FollowSeerrAsync"),
        })
        {
            var type = Plugin.GetType("Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire." + typeName)!;
            var method = type.GetMethods(Declared).Single(m => m.Name == methodName);
            Assert.Contains(PrivacyOutputPathScan.Referenced(method), reference => reference.DeclaringType == owner && reference.Name is "BackgroundAsync" or "Process");
        }
        // Cache handles may be held by callers, but their raw storage remains private to the owner.
        foreach (var cache in owner.GetNestedTypes(BindingFlags.NonPublic).Where(t => t.Name.StartsWith("Cache`", StringComparison.Ordinal) || t.Name.StartsWith("PreparedCache`", StringComparison.Ordinal)))
            Assert.All(cache.GetFields(Declared), f => Assert.True(f.IsPrivate, cache + "." + f.Name));
    }
}
