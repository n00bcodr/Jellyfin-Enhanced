using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard
{
    /// <summary>
    /// The series and films a user may see, by the rules Jellyfin applies to that user's own item lists: library
    /// access, maximum parental rating, blocked unrated items, and blocked or allowed tags. A Spoiler Guard entry names
    /// its title, so a title the user may not see is never armed for them and never sent back to them.
    /// </summary>
    internal static class SpoilerTitleVisibility
    {
        /// <summary>
        /// The ids of every series and film <paramref name="user"/> may see, from one id query; null when the user has
        /// none of those restrictions, so every title is visible.
        /// </summary>
        public static HashSet<Guid>? VisibleTitleIds(ILibraryManager libraryManager, User user)
        {
            var query = new InternalItemsQuery(user)
            {
                IncludeItemTypes = new[] { BaseItemKind.Series, BaseItemKind.Movie },
                IsVirtualItem = false,
                Recursive = true,
                GroupByPresentationUniqueKey = false,
            };
            if (user.HasPermission(PermissionKind.EnableAllFolders)
                && query.MaxParentalRating == null
                && query.BlockUnratedItems.Length == 0
                && query.ExcludeInheritedTags.Length == 0
                && query.IncludeInheritedTags.Length == 0)
            {
                return null;
            }

            return new HashSet<Guid>(libraryManager.GetItemIds(query));
        }

        /// <summary>
        /// Removes from <paramref name="state"/>, a copy read for one response, the series and film entries the user
        /// <paramref name="user"/> returns may not see (an unknown user sees none). The user is looked up only when
        /// the list names a series or film: every page load's bootstrap comes here. The stored file is not changed:
        /// an entry guards its title again if the user is later allowed to see it.
        /// </summary>
        public static UserSpoilerBlur WithoutHiddenTitles(ILibraryManager libraryManager, Func<User?> user, UserSpoilerBlur state)
        {
            if (state.Series.Count == 0 && state.Movies.Count == 0) return state;
            var owner = user();
            var visible = owner == null ? new HashSet<Guid>() : VisibleTitleIds(libraryManager, owner);
            if (visible == null) return state;

            bool Hidden(string key) => !Guid.TryParse(key, out var id) || !visible.Contains(id);
            foreach (var key in state.Series.Keys.Where(Hidden).ToList()) state.Series.Remove(key);
            foreach (var key in state.Movies.Keys.Where(Hidden).ToList()) state.Movies.Remove(key);
            return state;
        }
    }
}
