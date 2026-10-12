using System;
using System.IO;
using System.Threading.Tasks;
using Jellyfin.Data.Events.Users;
using MediaBrowser.Controller.Events;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify
{
    /// <summary>
    /// Removes what "Requests &amp; downloads" keeps about a Jellyfin user (follows, alert settings with
    /// their ntfy topic and e-mail address, inbox, queued deliveries, marks) the moment the user is
    /// deleted, whether notifications are on or not. The database is never created for it: a server
    /// that never used it has nothing to remove.
    /// </summary>
    public sealed class NotifyUserPurge : IEventConsumer<UserDeletedEventArgs>
    {
        private readonly NotifyStore _store;
        private readonly Logger _logger;

        /// <summary>Creates the consumer (DI).</summary>
        public NotifyUserPurge(NotifyStore store, Logger logger)
        {
            _store = store;
            _logger = logger;
        }

        /// <inheritdoc />
        public Task OnEvent(UserDeletedEventArgs eventArgs)
        {
            if (eventArgs?.Argument is { } user) Purge(_store, user.Id, _logger);
            return Task.CompletedTask;
        }

        /// <summary>Removes one user's rows (tests call it); returns how many went. Never throws.</summary>
        internal static int Purge(NotifyStore store, Guid userId, Logger? logger)
        {
            try
            {
                if (userId == Guid.Empty) return 0;
                // Noted first, so a write on its way for them drops their rows even if it is the one that creates the database.
                store.NoteDeleted(userId);
                if (!File.Exists(store.Database.FilePath) || !store.Available) return 0;
                var removed = store.PurgeUser(userId);
                if (removed > 0) logger?.Info($"Notifications: removed {removed} rows of a deleted user.");
                return removed;
            }
            catch (Exception ex)
            {
                logger?.Warning($"Notifications: could not remove a deleted user's rows ({ex.GetType().Name}); housekeeping removes them later.");
                return 0;
            }
        }
    }
}
