using System.Reflection;
using Microsoft.AspNetCore.Mvc;
using Xunit.Abstractions;

namespace JE.Tests.Architecture;

// Companion to Gate B (artifacts/restructure-plan/backend.md §3): request identity is read only by controllers (and
// JeControllerBase), UserHelper and RequestIdentityService. A helper that reads ControllerBase.User or calls a
// controller's IsAdminUser must stay a controller member; moving it into a service would make Gate B's counts lie.
//
// backend.md names Features/**/Services, Shared/** and Infrastructure/**. This checks every plugin type that is not a
// controller (or nested in one), which covers those namespaces and also the legacy Services/Helpers/Model namespaces
// that Phase 1 moves into Features/ without renaming.
public class ServicesDoNotReadUserTests(ITestOutputHelper output)
{
    private static readonly HashSet<string> Allowed = new(StringComparer.Ordinal) { "JeControllerBase", "UserHelper", "RequestIdentityService" };

    internal static bool ReadsUser(MemberInfo member) => member is MethodBase method && method.DeclaringType is { } type
        && ((type == typeof(ControllerBase) && method.Name == "get_User")
            || (method.Name == "IsAdminUser" && Arch.IsControllerType(type)));

    [Fact]
    public void NonControllerTypesDoNotReadControllerUser()
    {
        var scanned = 0;
        var offenders = new List<string>();
        foreach (var type in Arch.PluginTypes().Where(t => t.DeclaringType == null))
        {
            if (Arch.IsControllerType(type) || Allowed.Contains(type.Name)) continue;
            scanned++;
            foreach (var method in Arch.AllMethods(type))
                foreach (var reference in Arch.IlReferences(method).Where(ReadsUser).Distinct())
                    offenders.Add($"{type.FullName}.{method.Name} -> {reference.DeclaringType!.Name}.{reference.Name}");
        }
        output.WriteLine($"non-controller types scanned: {scanned}, offenders: {offenders.Count}");
        Assert.Empty(offenders);
    }
}
