using Jellyfin.Plugin.JellyfinEnhanced.Features.SpoilerGuard.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.SpoilerGuard
{
    /// <summary>
    /// Spoiler Guard's service registrations (restructure S2.13), called where its first line stood in
    /// PluginServiceRegistrator; the lines keep their original relative order. The policy services that other
    /// features inject live in Shared/SpoilerGuard (backend.md §7.7) and are still registered here. The MVC filter
    /// order stays in MvcFilterRegistration and the event consumer in EventConsumerRegistration.
    /// </summary>
    public static class SpoilerGuardServiceRegistration
    {
        public static IServiceCollection AddJeSpoilerGuard(this IServiceCollection serviceCollection)
        {
                // Spoiler Guard: an MVC action filter on the Image controller blurs
                // guarded-episode image bytes, so every client gets them via the native image API.
                serviceCollection.AddSingleton<ImageBlurService>();
                // Shared user-resolution + state-load helper. One instance, both filters use it
                // so the IPv6 / shared-IP / fail-closed logic stays in ONE place.
                serviceCollection.AddSingleton<SpoilerIdentityService>();
                serviceCollection.AddSingleton<SpoilerIdentityTagFilter>();
                serviceCollection.AddSingleton<SpoilerUserResolver>();
                serviceCollection.AddSingleton<SpoilerBlurImageFilter>();
                // Per-(user, series) next-unwatched boundary for the advanced
                // category reveals; owns its own bounded cache and evicts on
                // IUserDataManager.UserDataSaved (O(1) on the event thread).
                serviceCollection.AddSingleton<SpoilerNextUnwatchedService>();
                // Spoiler Field Strip: removes spoiler-y metadata (Overview, ratings,
                // title, cast, etc.) from BaseItemDto responses for guarded unwatched episodes.
                serviceCollection.AddSingleton<SpoilerFieldStripFilter>();
                // The same policy for the Seerr, TMDB and MDBList data JE shows itself.
                serviceCollection.AddSingleton<SpoilerSeerrRedactor>();

                // Promotes pending pre-acquisition Spoiler Guard entries (PendingTmdb)
                // into real Series/Movies entries when matching library items land.
                serviceCollection.AddHostedService<SpoilerSeerrPendingPromoter>();
                // Auto-enable Spoiler Guard for every user the moment a new
                // Series/Movie lands in the library (SpoilerAutoEnableOnLibraryAdd);
                // batches a scan's ItemAdded burst into one write per user.
                serviceCollection.AddHostedService<SpoilerLibraryAddAutoEnabler>();
                // Admin-triggered "apply to existing titles": the same scope and
                // write path for titles that were already in the library. Run by
                // SpoilerApplyExistingTitlesTask; previewed by the config page.
                serviceCollection.AddSingleton<SpoilerExistingTitlesApplier>();
                // Spoiler Guard's tag-data strip, shared by GET /tag-cache, POST
                // /tag-data and native poster tags.
                serviceCollection.AddSingleton<SpoilerTagDataStripper>();
            return serviceCollection;
        }
    }
}
