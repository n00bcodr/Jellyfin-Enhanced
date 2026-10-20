using System;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>
/// Policy fresh at emit: an answer JE builds under one read of the viewer's policies (Hidden Content, Spoiler Guard) leaves
/// only when a re-read after the build (after every wait and lock it took) finds the same revision. When a policy changed
/// meanwhile, the answer is built again under the new one, a bounded number of times; a policy that keeps changing gets
/// no answer (the caller withholds it) rather than one built under a policy that no longer applies.
/// </summary>
public static class PolicyFreshness
{
    /// <summary>How many times an answer is built before it is withheld.</summary>
    public const int Attempts = 3;

    /// <summary>Builds the answer until the revision it was built under is still current; null when it never was.</summary>
    /// <param name="build">Builds the answer; returns it with the revision of the policies it read.</param>
    /// <param name="current">Re-reads the policies' revision.</param>
    public static T? Fresh<T>(Func<(T Answer, string Revision)> build, Func<string> current) where T : class
    {
        for (var attempt = 0; attempt < Attempts; attempt++)
        {
            var (answer, revision) = build();
            if (string.Equals(current(), revision, StringComparison.Ordinal)) return answer;
        }
        return null;
    }

    /// <summary>The asynchronous <see cref="Fresh{T}"/> (an answer whose build awaits).</summary>
    public static async Task<T?> FreshAsync<T>(Func<Task<(T Answer, string Revision)>> build, Func<string> current) where T : class
    {
        for (var attempt = 0; attempt < Attempts; attempt++)
        {
            var (answer, revision) = await build().ConfigureAwait(false);
            if (string.Equals(current(), revision, StringComparison.Ordinal)) return answer;
        }
        return null;
    }
}
