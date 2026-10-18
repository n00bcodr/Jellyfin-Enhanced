#if JF12
using System;
using System.Globalization;
using Jellyfin.Database.Implementations.Entities;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>
    /// Whether a viewer guards a not-in-library title with Spoiler Guard. The library's strip and
    /// image filters run after the native action, which a synthetic answer never reaches, so the
    /// native details facade and the absent-title pages apply Spoiler Guard themselves.
    /// </summary>
    internal static class NativeDetailsSpoilers
    {
        /// <summary>
        /// The viewer's Spoiler Guard state when Spoiler Guard is on and they guard this title: its
        /// library copy is on their list, or they turned it on from Seerr before the title arrived (a
        /// pending entry). Null otherwise.
        /// </summary>
        /// <param name="users">Spoiler Guard's per-user state reader (null: Spoiler Guard isn't running).</param>
        /// <param name="policy">The native details policy (the title's library copies).</param>
        /// <param name="http">The request (per-request state cache), or null.</param>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="title">Any synthetic id of the title.</param>
        /// <returns>The viewer's state, or null.</returns>
        internal static Configuration.UserSpoilerBlur? Guarded(SpoilerUserResolver? users, NativeDetailsPolicy policy, HttpContext? http, User viewer, SyntheticId title)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (users == null || config?.SpoilerBlurEnabled != true || title.Kind == SyntheticKind.Person) return null;
            Configuration.UserSpoilerBlur state;
            try
            {
                state = users.LoadUserState(http ?? new DefaultHttpContext(), viewer.Id);
            }
            catch (Exception)
            {
                // Unknown: treated as guarded with the admin's defaults.
                return new Configuration.UserSpoilerBlur();
            }

            var pending = (title.IsMovie ? "movie:" : "tv:") + title.TmdbId.ToString(CultureInfo.InvariantCulture);
            if (state.PendingTmdb.ContainsKey(pending) || SpoilerUserResolver.ProviderGuarded(state, title.IsMovie ? "movie" : "tv", title.TmdbId.ToString(CultureInfo.InvariantCulture))) return state;
            if (state.Series.Count == 0 && state.Movies.Count == 0 && state.Collections.Count == 0) return null;
            foreach (var copy in policy.Physical(viewer, title.IsMovie, title.TmdbId, null).Copies)
            {
                if (title.IsMovie ? users.IsMovieInSpoilerScope(state, copy) : state.Series.ContainsKey(copy.ToString("N"))) return state;
            }

            return null;
        }
    }
}
#endif
