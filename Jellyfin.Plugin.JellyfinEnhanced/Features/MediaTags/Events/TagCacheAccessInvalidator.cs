using System.Threading.Tasks;
using Jellyfin.Data.Events.Users;
using MediaBrowser.Controller.Events;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Events
{
    // Tag-cache responses are filtered by a per-user access set cached for up
    // to a minute; a policy change (libraries, parental limits, tags) must
    // apply to the very next request, because clients keep their copy and the
    // response's filterRevision is derived from that same set.
    public sealed class TagCacheAccessInvalidator : IEventConsumer<UserUpdatedEventArgs>, IEventConsumer<UserDeletedEventArgs>
    {
        private readonly TagCacheService _tagCache;

        public TagCacheAccessInvalidator(TagCacheService tagCache)
        {
            _tagCache = tagCache;
        }

        public Task OnEvent(UserUpdatedEventArgs eventArgs)
        {
            _tagCache.InvalidateUserAccess();
            return Task.CompletedTask;
        }

        public Task OnEvent(UserDeletedEventArgs eventArgs)
        {
            _tagCache.InvalidateUserAccess();
            return Task.CompletedTask;
        }
    }
}
