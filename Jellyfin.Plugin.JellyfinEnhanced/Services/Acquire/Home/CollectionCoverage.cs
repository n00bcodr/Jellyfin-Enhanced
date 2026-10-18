using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Home
{
    /// <summary>
    /// The titles a collection's list already holds as entries (titles not in the library) that one viewer can see, so
    /// the collection's gaps block ("Get the N missing") never offers the same title a second time. Viewer-filtered:
    /// an entry the viewer may not see (their parental limits, an unverifiable entry someone else added, a list they
    /// can't open, list entries switched off for them) is never part of the answer, so it never changes what they are
    /// shown or how many. The list UI may replace the default implementation with its own projection.
    /// </summary>
    public interface ICollectionCoverage
    {
        /// <summary>
        /// The title keys (<c>movie:tmdb:{id}</c>, as list entries name them) of the movie entries of the collection's list
        /// the viewer can see; empty when lists are off, the collection has no list document or the viewer can't open it.
        /// Never throws for a missing or unreadable list (the answer is then empty).
        /// </summary>
        /// <param name="collectionId">The collection (BoxSet) item id.</param>
        /// <param name="viewer">The viewer.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The covered title keys.</returns>
        Task<IReadOnlySet<string>> CoveredAsync(Guid collectionId, StatusViewer viewer, CancellationToken ct);

        /// <summary>Prepares parental evidence; invoke the returned projection only at the final response boundary.</summary>
        /// <param name="collectionId">Collection.</param>
        /// <param name="viewer">Viewer.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>A synchronous current-coverage projection.</returns>
        Task<Func<IReadOnlySet<string>>> PrepareAsync(Guid collectionId, StatusViewer viewer, CancellationToken ct);

    }

    /// <summary>
    /// <see cref="ICollectionCoverage"/> over the list store: the movie entries of the collection's list document, for a
    /// viewer who can view the list (Jellyfin's collection visibility), whose list entries are shown (lists on, their
    /// preference not off) and minus the entries <see cref="ListAccessService.GetHiddenPlaceholderIdsAsync"/> hides from
    /// them. Every edition of a title counts: the title is on the page already.
    /// </summary>
    public sealed class ListCollectionCoverage : ICollectionCoverage
    {
        private static readonly IReadOnlySet<string> None = new HashSet<string>(StringComparer.Ordinal);

        private readonly ListStore _store;
        private readonly ListAccessService _access;
        private readonly IUserManager? _users;
        private readonly IListPreferences? _preferences;
        private readonly Func<Configuration.PluginConfiguration?> _config;
        private readonly Logger? _logger;

        /// <summary>Creates the coverage reader (DI).</summary>
        /// <param name="store">List documents.</param>
        /// <param name="access">List rights and the entry parental filter.</param>
        /// <param name="users">Users (the viewer when the request didn't carry the user object).</param>
        /// <param name="preferences">Per-person list preferences (null: everyone follows the administrator).</param>
        /// <param name="logger">JE logger.</param>
        public ListCollectionCoverage(ListStore store, ListAccessService access, IUserManager users, IListPreferences? preferences = null, Logger? logger = null)
            : this(store, access, users, preferences, () => JellyfinEnhanced.Instance?.Configuration, logger)
        {
        }

        /// <summary>Creates the coverage reader with an explicit configuration (tests).</summary>
        /// <param name="store">List documents.</param>
        /// <param name="access">List rights and the entry parental filter.</param>
        /// <param name="users">Users.</param>
        /// <param name="preferences">Per-person list preferences.</param>
        /// <param name="config">Configuration.</param>
        /// <param name="logger">JE logger.</param>
        internal ListCollectionCoverage(ListStore store, ListAccessService access, IUserManager? users, IListPreferences? preferences, Func<Configuration.PluginConfiguration?> config, Logger? logger)
        {
            _store = store;
            _access = access;
            _users = users;
            _preferences = preferences;
            _config = config;
            _logger = logger;
        }

        /// <inheritdoc />
        public async Task<IReadOnlySet<string>> CoveredAsync(Guid collectionId, StatusViewer viewer, CancellationToken ct)
            => (await PrepareAsync(collectionId, viewer, ct).ConfigureAwait(false))();

        /// <inheritdoc />
        public async Task<Func<IReadOnlySet<string>>> PrepareAsync(Guid collectionId, StatusViewer viewer, CancellationToken ct)
        {
            if (collectionId == Guid.Empty || !ListFlags.Lists(_config())) return () => None;
            var user = _users == null ? viewer.Handle as User : _users.GetUserById(viewer.UserId);
            if (user == null || user.Id != viewer.UserId) return () => None;

            ListDoc? doc;
            try
            {
                doc = _store.Load(collectionId.ToString("N"));
            }
            catch (InvalidDataException ex)
            {
                // An unreadable document covers nothing (the gaps block then offers every missing title, as before).
                _logger?.Debug($"[Lists] Collection coverage of {collectionId:N} skipped: {ex.Message}");
                return () => None;
            }

            var movies = (doc?.Items ?? new List<Placeholder>())
                .Where(p => p.Kind == PlaceholderKinds.Movie && p.MediaType == "movie" && p.TmdbId is > 0)
                .ToList();
            if (movies.Count == 0) return () => None;
            var visibility = await _access.Gate.VisibilityAsync(movies, user, ct).ConfigureAwait(false);
            return () =>
            {
                // This closure is preparation, not an answer. No captured key set authorises coverage later.
                var fresh = _users == null ? viewer.Handle as User : _users.GetUserById(viewer.UserId);
                if (fresh == null || fresh.HasPermission(PermissionKind.IsDisabled)
                    || _access.Resolve(collectionId, fresh) is not { Permissions.CanView: true } current
                    || !visibility.Matches(_access.ParentalStamp(current.User))
                    || !ListFlags.Lists(_config()) || current.List.Kind != ListKinds.Collection
                    || !ListFlags.Display(true, _preferences?.For(current.User.Id).Placeholders)) return None;
                try
                {
                    return (_store.Load(current.ListIdN)?.Items ?? new List<Placeholder>())
                        .Where(p => p.Kind == PlaceholderKinds.Movie && p.MediaType == "movie" && p.TmdbId is > 0 && visibility.IsVisible(p))
                        .Select(p => "movie:tmdb:" + p.TmdbId!.Value.ToString(CultureInfo.InvariantCulture))
                        .ToHashSet(StringComparer.Ordinal);
                }
                catch (InvalidDataException) { return None; }
            };
        }
    }
}
