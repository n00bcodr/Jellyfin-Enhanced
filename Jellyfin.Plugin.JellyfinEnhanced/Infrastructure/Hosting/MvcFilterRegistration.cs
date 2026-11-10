using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.HiddenContent;
using Jellyfin.Plugin.JellyfinEnhanced.Features.SpoilerGuard.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard;

namespace Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Hosting
{
    /// <summary>
    /// The MVC filter block, verbatim and in one place (restructure S2.0b, backend.md §2 "DI registration" item 2):
    /// the filters belong to three features, but their registration order is behaviour.
    /// </summary>
    public static class MvcFilterRegistration
    {
        public static IServiceCollection AddJeMvcFilters(this IServiceCollection serviceCollection)
        {
            serviceCollection.Configure<MvcOptions>(o =>
            {
                // All are IAsyncActionFilters that rewrite the response after
                // `await next()`, so post-processing runs in REVERSE registration order.
                // Identity-tag stamping must run after field-strip cache-busting so
                // clients echo the final "sb-...-jet...-jeu..." tag on image requests.
                // The poster tag image filter is registered BEFORE the blur filter so
                // it post-processes AFTER it: tags are drawn on Spoiler Guard's output.
                o.Filters.AddService<HiddenContentResponseFilter>();
                o.Filters.AddService<SpoilerIdentityTagFilter>();
                o.Filters.AddService<SpoilerFieldStripFilter>();
                o.Filters.AddService<PosterTagImageFilter>();
                o.Filters.AddService<SpoilerBlurImageFilter>();
            });
            return serviceCollection;
        }
    }
}
