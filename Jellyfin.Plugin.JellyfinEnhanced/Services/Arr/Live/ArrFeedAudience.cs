using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live
{
    /// <summary>Decides which changed titles a user may hear about.</summary>
    public interface IArrFeedAudience
    {
        /// <summary>The keys among <paramref name="changes"/> the user may see.</summary>
        IReadOnlyCollection<string> Visible(Guid userId, bool isAdmin, IReadOnlyList<ArrFeedChange> changes);
    }

    /// <summary>
    /// The change feed's per-user filter, applied before any key leaves the server. Administrators
    /// hear about everything. Anyone else hears about a title when:
    /// <list type="bullet">
    /// <item><description>it is in Jellyfin and they can open it there (library access, parental
    /// rating and tags, as Jellyfin decides for that user); or</description></item>
    /// <item><description>it is not in Jellyfin at all (still on its way), they have no content
    /// limit (rating, blocked or allowed tags, unrated items, blocked folders), and they can open
    /// a library the arr instance is linked to (an instance with no linked libraries is open to
    /// all). A change that names no instance (Jellyfin's own library adds and removes) is checked
    /// against the instances that hold the title; none holding it means no (but see the request
    /// rule below); or</description></item>
    /// <item><description>it is not in Jellyfin at all and they asked for it themselves (the
    /// request read model says so), whatever their limits: they already know the title; or</description></item>
    /// <item><description>it is not in Jellyfin, no arr instance holds it, someone in the household
    /// asked for it in Seerr, the change names no instance (a request change) and the user has no
    /// content limits (the same people who can read its status by key).</description></item>
    /// </list>
    /// "Asked for" includes requests deleted in the last few minutes, so the deletion itself is
    /// announced to the people who could follow the title before it.
    /// A user's request-list key (<see cref="ArrTitleKey.UserRequests"/>) reaches that user only,
    /// administrators included; the shared <see cref="ArrTitleKey.RequestsState"/> key reaches everyone.
    /// Season and episode keys are checked against that season or episode when Jellyfin has it
    /// (Jellyfin can hide one episode of a visible series), otherwise as their series. A title in
    /// Jellyfin that the user can't open is never announced. A Jellyfin copy known only by another
    /// id (IMDb, or TMDB for a series) is found through the ids the arr libraries hold for the
    /// title. A key that changed in several instances is announced when any of them (or
    /// Jellyfin's copy) may be seen. Answers are cached per user, key and instance for a minute,
    /// and only while nothing they depend on changed: the user's policy (role, library access,
    /// parental settings), Jellyfin's library, and the instances' linked libraries.
    /// </summary>
    public sealed class ArrFeedAudience : IArrFeedAudience
    {
        private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(1);
        private const int MaxCacheEntries = 20_000;

        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly ArrStateStore _store;
        private readonly IArrJellyfinView _view;
        private readonly IArrRequestFacts? _requests;
        private readonly Func<DateTimeOffset> _now;
        private readonly ConcurrentDictionary<(Guid User, string Key, string? Instance), (bool Visible, DateTimeOffset At, string Stamp)> _cache = new();
        private (IReadOnlyList<ArrConnection>? Instances, string Stamp) _registryStamp;

        /// <summary>Creates the filter (DI).</summary>
        public ArrFeedAudience(ILibraryManager libraryManager, IUserManager userManager, ArrStateStore store, IArrJellyfinView view, IArrRequestFacts requests)
            : this(libraryManager, userManager, store, null, view, requests)
        {
        }

        /// <summary>Creates the filter with a clock, its own Jellyfin view and request facts (tests).</summary>
        internal ArrFeedAudience(ILibraryManager libraryManager, IUserManager userManager, ArrStateStore store, Func<DateTimeOffset>? now = null, IArrJellyfinView? view = null, IArrRequestFacts? requests = null)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _store = store;
            _view = view ?? new ArrJellyfinView(libraryManager, userManager);
            _requests = requests;
            _now = now ?? (() => DateTimeOffset.UtcNow);
        }

        /// <inheritdoc />
        public IReadOnlyCollection<string> Visible(Guid userId, bool isAdmin, IReadOnlyList<ArrFeedChange> changes)
        {
            if (changes.Count == 0) return Array.Empty<string>();
            // Request-list keys reach their owner only; everything else is a title key.
            var own = new List<string>();
            var titles = new List<ArrFeedChange>(changes.Count);
            foreach (var change in changes)
            {
                if (ArrTitleKey.TryParseUserRequests(change.Key, out var owner))
                {
                    if (owner == userId) own.Add(change.Key);
                }
                else if (change.Key == ArrTitleKey.RequestsState)
                {
                    own.Add(change.Key);
                }
                else
                {
                    titles.Add(change);
                }
            }
            if (isAdmin) return own.Concat(titles.Select(c => c.Key)).ToList();
            if (titles.Count == 0) return own;
            changes = titles;
            var user = _userManager.GetUserById(userId);
            if (user == null) return own;
            if (_cache.Count > MaxCacheEntries) _cache.Clear();

            var now = _now();
            // What every answer depends on besides the key: a change to any of it decides afresh.
            var stamp = (_view.Viewer(userId)?.PolicyRevision ?? string.Empty)
                + "|" + _view.Revision.ToString(CultureInfo.InvariantCulture)
                + "|" + RegistryStamp()
                + "|" + (_requests?.Revision ?? 0).ToString(CultureInfo.InvariantCulture);
            var visible = own;
            foreach (var change in changes)
            {
                if (!ArrTitleKey.TryParse(change.Key, out _, out _, out _, out _)) continue;
                if (change.AllSources.Any(source => Cached(user, change.Key, source, now, stamp))) visible.Add(change.Key);
            }
            return visible;
        }

        // The instances and the libraries they are linked to (the list is rebuilt only when the configuration changes).
        private string RegistryStamp()
        {
            var all = _store.Registry.All();
            var known = _registryStamp;
            if (ReferenceEquals(known.Instances, all)) return known.Stamp;
            var stamp = string.Join(";", all.Select(c => c.Id + ":" + c.Kind + ":" + (c.Usable ? "u" : "-") + ":" + string.Join(",", c.LinkedLibraryIds.OrderBy(l => l, StringComparer.OrdinalIgnoreCase))));
            _registryStamp = (all, stamp);
            return stamp;
        }

        private bool Cached(User user, string key, string? instanceId, DateTimeOffset now, string stamp)
        {
            var cacheKey = (user.Id, key, instanceId);
            if (_cache.TryGetValue(cacheKey, out var hit) && now - hit.At < CacheTtl && string.Equals(hit.Stamp, stamp, StringComparison.Ordinal)) return hit.Visible;
            var ok = Decide(user, key, instanceId, now, stamp);
            _cache[cacheKey] = (ok, now, stamp);
            return ok;
        }

        private bool Decide(User user, string key, string? instanceId, DateTimeOffset now, string stamp)
        {
            if (!ArrTitleKey.TryParse(key, out var type, out var id, out var season, out var episode)) return false;
            if (season != null)
            {
                // The series first (cached): a hidden series hides all of it.
                if (!Cached(user, ArrTitleKey.Series(id), instanceId, now, stamp)) return false;
                try
                {
                    return DecidePart(user, id, season.Value, episode);
                }
                catch (Exception)
                {
                    return false;
                }
            }

            var kind = type == "movie" ? BaseItemKind.Movie : BaseItemKind.Series;
            var provider = Providers(type == "movie", id);
            try
            {
                if (Find(new InternalItemsQuery(user), kind, provider).Count > 0) return true;
                if (Find(new InternalItemsQuery(), kind, provider).Count > 0) return false;
            }
            catch (Exception)
            {
                return false;
            }
            // Not in Jellyfin: someone who asked for it hears about it whatever their limits.
            var title = TitleKey.Parse(type == "movie" ? ArrTitleKey.Movie(id) : ArrTitleKey.Series(id));
            // "Asked" includes a request deleted in the last few minutes: its own announcement is
            // decided after the list no longer has it.
            if (_requests != null && title != null && _requests.AskedLatelyBy(title, user.Id)) return true;
            if (!Unrestricted(user)) return false;
            var instances = (instanceId != null
                ? new[] { instanceId }
                : Holders(type == "movie" ? ArrKind.Radarr : ArrKind.Sonarr, id)).ToList();
            // A title only Seerr knows (no arr holds it yet): its request changes (approved, declined)
            // reach every member without content limits, who can already read its status by key
            // ("Asked by someone in your household").
            if (instanceId == null && instances.Count == 0) return _requests != null && title != null && _requests.RequestedLately(title);
            return instances.Any(i => CanOpenLinkedLibrary(user, i));
        }

        // A season or episode of a series the user may hear about: the item itself when Jellyfin
        // has it (its own rating and tags may hide it), the series' answer otherwise. The user's
        // lookup runs only under the series copies the user can open: with ancestors set, Jellyfin
        // doesn't limit a user's query to their libraries, so another library's copy of the series
        // would otherwise answer for them.
        private bool DecidePart(User user, int tvdbId, int season, int? episode)
        {
            var provider = Providers(movie: false, tvdbId);
            var all = Find(new InternalItemsQuery(), BaseItemKind.Series, provider, limit: 10).Select(i => i.Id).ToArray();
            if (all.Length == 0) return true;   // not in Jellyfin: the series' answer stands
            var mine = Find(new InternalItemsQuery(user), BaseItemKind.Series, provider, limit: 10).Select(i => i.Id).ToArray();
            if (mine.Length > 0 && FindPart(new InternalItemsQuery(user), mine, season, episode)) return true;
            return !FindPart(new InternalItemsQuery(), all, season, episode);
        }

        private bool FindPart(InternalItemsQuery query, Guid[] seriesIds, int season, int? episode)
        {
            query.AncestorIds = seriesIds;
            query.Recursive = true;
            query.Limit = 1;
            if (episode is int e)
            {
                query.IncludeItemTypes = new[] { BaseItemKind.Episode };
                query.ParentIndexNumber = season;
                query.IndexNumber = e;
            }
            else
            {
                query.IncludeItemTypes = new[] { BaseItemKind.Season };
                query.IndexNumber = season;
            }
            return _libraryManager.GetItemList(query).Count > 0;
        }

        private IReadOnlyList<BaseItem> Find(InternalItemsQuery query, BaseItemKind kind, Dictionary<string, string> providers, int limit = 1)
        {
            query.IncludeItemTypes = new[] { kind };
            query.HasAnyProviderId = new Dictionary<string, string>(providers, StringComparer.OrdinalIgnoreCase);
            query.Recursive = true;
            query.Limit = limit;
            return _libraryManager.GetItemList(query);
        }

        // The title's ids as Jellyfin may know them: the key's own (TMDB for a movie, TVDB for a
        // series) plus the IMDb (and, for a series, TMDB) ids the arr libraries hold for it, so a
        // Jellyfin copy matched only by one of those still decides.
        private Dictionary<string, string> Providers(bool movie, int id)
        {
            var providers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                [movie ? "Tmdb" : "Tvdb"] = id.ToString(CultureInfo.InvariantCulture),
            };
            foreach (var c in _store.Registry.All().Where(c => c.Kind == (movie ? ArrKind.Radarr : ArrKind.Sonarr) && c.Usable))
            {
                if (_store.PeekLibrary(c.Id) is not { } library) continue;
                if (movie)
                {
                    if (library.MovieByTmdb(id)?.ImdbId is { Length: > 0 } imdb) providers.TryAdd("Imdb", imdb);
                }
                else if (library.SeriesByTvdb(id) is { } series)
                {
                    if (series.TmdbId is > 0 and var tmdb) providers.TryAdd("Tmdb", tmdb.ToString(CultureInfo.InvariantCulture));
                    if (series.ImdbId is { Length: > 0 } imdb) providers.TryAdd("Imdb", imdb);
                }
            }
            return providers;
        }

        // The instances whose library index holds the title (a change without an instance).
        private IEnumerable<string> Holders(ArrKind kind, int providerId)
            => _store.Registry.All()
                .Where(c => c.Kind == kind && c.Usable)
                .Where(c => _store.PeekLibrary(c.Id) is { } library
                    && (kind == ArrKind.Radarr ? library.MovieByTmdb(providerId) != null : library.SeriesByTvdb(providerId) != null))
                .Select(c => c.Id)
                .ToList();

        // No content limit of any kind (as Jellyfin's own "has content restrictions", minus folder
        // access, which the linked libraries decide). Titles not in Jellyfin have no rating or tags
        // to check, so a user with any such limit hears only about titles Jellyfin can check.
        private static bool Unrestricted(User user)
            => user.MaxParentalRatingScore == null
               && NoneSet(user.GetPreference(PreferenceKind.BlockedTags))
               && NoneSet(user.GetPreference(PreferenceKind.AllowedTags))
               && NoneSet(user.GetPreference(PreferenceKind.BlockedMediaFolders))
               && user.GetPreferenceValues<UnratedItem>(PreferenceKind.BlockUnratedItems).Length == 0;

        private static bool NoneSet(string[]? values) => (values ?? Array.Empty<string>()).All(string.IsNullOrWhiteSpace);

        private bool CanOpenLinkedLibrary(User user, string instanceId)
        {
            var linked = _store.Registry.Get(instanceId)?.LinkedLibraryIds;
            if (linked == null || linked.Count == 0 || user.HasPermission(PermissionKind.EnableAllFolders)) return true;
            var enabled = user.GetPreferenceValues<Guid>(PreferenceKind.EnabledFolders);
            return linked.Any(l => Guid.TryParse(l, out var g) && enabled.Contains(g));
        }
    }
}
