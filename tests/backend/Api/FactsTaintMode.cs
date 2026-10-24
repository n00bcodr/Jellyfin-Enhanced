using System.Runtime.CompilerServices;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
namespace JE.Tests;

internal static class FactsTaintMode
{
    [ModuleInitializer]
    internal static void Initialize()
    {
        UserCacheRegistry.TaintMode = Environment.GetEnvironmentVariable("JE_FACTS_TAINT") == "1";
        if (Environment.GetEnvironmentVariable("JE_FACTS_RECEIPT") is { Length: > 0 } path)
            AppDomain.CurrentDomain.ProcessExit += (_, _) => File.WriteAllText(path, System.Text.Json.JsonSerializer.Serialize(new
            {
                enabled = UserCacheRegistry.TaintMode,
                handouts = UserCacheRegistry.TaintedHandouts,
                envelopeStores = UserCacheRegistry.TaintedEnvelopeStores,
                rejectedPlainStores = UserCacheRegistry.RejectedPlainStores,
                stateCaptures = UserCacheRegistry.TaintedStateCaptures,
            }));
    }
}
