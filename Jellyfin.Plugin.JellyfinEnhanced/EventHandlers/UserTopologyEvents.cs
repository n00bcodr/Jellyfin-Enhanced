using System.Threading.Tasks;
using Jellyfin.Data.Events.Users;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Events;

namespace Jellyfin.Plugin.JellyfinEnhanced.EventHandlers
{
    // Invalidate the identity caches the moment the user set changes, so the
    // single-user shortcut and the marker→user map never serve a stale view
    // of WHO EXISTS. Without this, both caches ride short TTLs alone:
    //   • a just-created second user could briefly be attributed to the old
    //     lone user by the single-user shortcut (accidental misattribution —
    //     the one thing the identity design must never do), and
    //   • a just-created user's freshly stamped marker could go unresolved
    //     for up to the map-rebuild throttle and fall back to the IP ladder.
    // Event-driven invalidation closes both windows exactly (user churn is
    // rare; the TTLs remain as belt-and-braces for anything the events miss).
    public sealed class UserCreatedIdentityInvalidator : IEventConsumer<UserCreatedEventArgs>
    {
        private readonly RequestIdentityService _identity;
        private readonly SpoilerIdentityService _markers;

        public UserCreatedIdentityInvalidator(RequestIdentityService identity, SpoilerIdentityService markers)
        {
            _identity = identity;
            _markers = markers;
        }

        public Task OnEvent(UserCreatedEventArgs eventArgs)
        {
            _identity.InvalidateUserTopology();
            _markers.InvalidateMap();
            return Task.CompletedTask;
        }
    }

    public sealed class UserDeletedIdentityInvalidator : IEventConsumer<UserDeletedEventArgs>
    {
        private readonly RequestIdentityService _identity;
        private readonly SpoilerIdentityService _markers;

        public UserDeletedIdentityInvalidator(RequestIdentityService identity, SpoilerIdentityService markers)
        {
            _identity = identity;
            _markers = markers;
        }

        public Task OnEvent(UserDeletedEventArgs eventArgs)
        {
            _identity.InvalidateUserTopology();
            _markers.InvalidateMap();
            return Task.CompletedTask;
        }
    }
}
