using System.Threading.Tasks;
using Jellyfin.Data.Events.Users;
using MediaBrowser.Controller.Events;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Reviews;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Events
{
    // Review visibility depends on the author's hidden/disabled flags and on
    // the author still existing, and ReviewAuthorCache keeps resolved authors
    // across requests: drop them the moment any user is updated (policy,
    // rename), locked out (failed logins disable the account) or deleted, so
    // the change applies to the next request.
    public sealed class ReviewAuthorCacheInvalidator : IEventConsumer<UserUpdatedEventArgs>, IEventConsumer<UserDeletedEventArgs>, IEventConsumer<UserLockedOutEventArgs>
    {
        public Task OnEvent(UserUpdatedEventArgs eventArgs)
        {
            ReviewAuthorCache.Invalidate();
            return Task.CompletedTask;
        }

        public Task OnEvent(UserDeletedEventArgs eventArgs)
        {
            ReviewAuthorCache.Invalidate();
            return Task.CompletedTask;
        }

        public Task OnEvent(UserLockedOutEventArgs eventArgs)
        {
            ReviewAuthorCache.Invalidate();
            return Task.CompletedTask;
        }
    }
}
