using System.Collections;
using System.Reflection;

namespace JE.Tests;

// Existing cache-lifetime tests deliberately await the private worker instead of sleeping.
internal static class SeerrFactTestAccess
{
    internal static object Gate => typeof(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends.EffectiveRequestsBackend)
        .GetField("_gate", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends.EffectiveRequestsBackend.Shared)!;
    internal static object OwnershipEntries(object handle)
    {
        var raw = handle.GetType().GetField("_cache", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(handle)!;
        return (IDictionary)raw.GetType().GetField("_entries", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(raw)!;
    }
}
