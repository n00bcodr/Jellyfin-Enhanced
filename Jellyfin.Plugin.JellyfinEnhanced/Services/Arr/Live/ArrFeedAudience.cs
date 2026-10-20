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
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live
{
    /// <summary>Decides which changed titles a user may hear about.</summary>
    public interface IArrFeedAudience
    {
        /// <summary>The keys among <paramref name="changes"/> the user may see.</summary>
        /// <param name="userId">The user.</param>
        /// <param name="isAdmin">True for an administrator (sees every title).</param>
        /// <param name="changes">The keys (and the instances they changed in) to decide.</param>
        /// <param name="askedFor">
        /// Movie and series keys (<see cref="ArrTitleKey.Movie"/>, <see cref="ArrTitleKey.Series"/>)
        /// the caller has proof the user asked for, besides the request read model (the legacy
        /// Requests page reads the user's Seerr requests itself). A title Jellyfin doesn't have that
        /// is otherwise hidden from the user is shown when its movie or series key is in it; a title
        /// Jellyfin has stays Jellyfin's decision.
        /// </param>
        /// <param name="absent">
        /// When given, receives the keys left out only for want of proof the user asked for them
        /// (not in Jellyfin, and nothing else lets the user see them): the ones a caller's own read
        /// of the user's requests could still show. A caller with no such keys needs no such read.
        /// </param>
        IReadOnlyCollection<string> Visible(Guid userId, bool isAdmin, IReadOnlyList<ArrFeedChange> changes, IReadOnlySet<string>? askedFor = null, ICollection<string>? absent = null);
    }

    /// <summary>
    /// The change feed's per-user filter, applied before any key leaves the server. Administrators
    /// hear about everything. Anyone else hears about a title when:
    /// <list type="bullet">
    /// <item><description>it is in Jellyfin and they can open it there (library access, parental
    /// rating and tags, as Jellyfin decides for that user); or</description></item>
    /// <item><description>it is not in Jellyfin at all (still on its way), they have no content
    /// limit (rating, blocked or allowed tags, unrated items), and they can open the library
    /// resolved from the title folder or the instance's linked libraries. Unresolved destinations
    /// require every library. A change that names no instance (Jellyfin's own library adds and removes) is checked
    /// against the instances that hold the title; none holding it means no (but see the request
    /// rule below); or</description></item>
    /// <item><description>it is not in Jellyfin at all and they asked for it themselves (the
    /// request read model says so), whatever their limits: they already know the title; or</description></item>
    /// <item><description>it is not in Jellyfin, no arr instance holds it, someone in the household
    /// asked for it in Seerr, the change names no instance (a request change) and the user has no
    /// content limits (the same people who can read its status by key).</description></item>
    /// </list>
    /// "Asked for" includes requests deleted in the last few minutes, so the deletion itself is
    /// announced to the people who could follow the title before it, and the titles a caller passes
    /// as asked for (the legacy Requests page's own read of the user's requests).
    /// A user's request-list and inbox keys (<see cref="ArrTitleKey.UserRequests"/>,
    /// <see cref="ArrTitleKey.UserInbox"/>) reach that user only, administrators included; the shared
    /// <see cref="ArrTitleKey.RequestsState"/> key reaches everyone; <see cref="ArrTitleKey.AdminOps"/>
    /// reaches administrators only.
    /// Season and episode keys are checked against that season or episode when Jellyfin has it
    /// (Jellyfin can hide one episode of a visible series), otherwise as their series. A title in
    /// Jellyfin that the user can't open is never announced. A Jellyfin copy known only by another
    /// id (IMDb, or TMDB for a series) is found through the ids the arr libraries hold for the
    /// title. A key that changed in several instances is announced when any of them (or
    /// Jellyfin's copy) may be seen. Answers are cached per user, key and instance for a minute,
    /// and only while nothing they depend on changed: the user's policy (role, library access,
    /// parental settings), Jellyfin's library, and the instances' linked libraries. Episodes are
    /// looked up a season at a time (the series' copies once per series), so a long list of
    /// episodes costs a few library queries per season rather than several per episode.
    /// </summary>
    public sealed class ArrFeedAudience : IArrFeedAudience
    {
        private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(1);
        private const int MaxCacheEntries = 20_000;

        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly ArrStateStore _store;
        private readonly Acquire.TitleAliases _aliases;
        private readonly IArrJellyfinView _view;
        private readonly IArrRequestFacts? _requests;
        private readonly ArrInstanceLibraries _libraries;
        private readonly Func<DateTimeOffset> _now;
        private readonly ConcurrentDictionary<(Guid User, string Key, string? Instance), (Verdict Verdict, DateTimeOffset At, string Stamp)> _cache = new();
        private readonly ConcurrentDictionary<(Guid User, int Tvdb), (SeriesCopies Copies, DateTimeOffset At, string Stamp)> _series = new();
        private readonly ConcurrentDictionary<(Guid User, int Tvdb, int Season), (SeasonEpisodes Episodes, DateTimeOffset At, string Stamp)> _seasons = new();
        private volatile AliasInputs? _registryStamp;

        // The snapshots and their token are published together for concurrent route reads.
        private sealed record AliasInputs(IReadOnlyList<ArrConnection> Instances, object?[] Snapshots, string Stamp);

        /// <summary>Creates the filter (DI).</summary>
        public ArrFeedAudience(ILibraryManager libraryManager, IUserManager userManager, ArrStateStore store, IArrJellyfinView view, IArrRequestFacts requests, ArrInstanceLibraries libraries)
            : this(libraryManager, userManager, store, null, view, requests, libraries)
        {
        }

        /// <summary>Creates the filter with a clock, its own Jellyfin view and request facts (tests).</summary>
        internal ArrFeedAudience(ILibraryManager libraryManager, IUserManager userManager, ArrStateStore store, Func<DateTimeOffset>? now = null, IArrJellyfinView? view = null, IArrRequestFacts? requests = null, ArrInstanceLibraries? libraries = null)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _store = store;
            _aliases = new Acquire.TitleAliases(store, requests as SeerrRequestReadModel);
            _view = view ?? new ArrJellyfinView(libraryManager, userManager);
            _requests = requests;
            _now = now ?? (() => DateTimeOffset.UtcNow);
            _libraries = libraries ?? new ArrInstanceLibraries(store, () => JellyfinLibraryAccess.ReadLibraries(libraryManager), _now);
        }

        // A title key's answer before the caller's own proof of asking: Absent = not in Jellyfin and
        // nothing else lets the user see it, so it is shown only to someone known to have asked.
        private enum Verdict : byte
        {
            Hidden,
            Visible,
            Absent,
        }

        // The Jellyfin copies of a series: every one, and the ones the user may open.
        private sealed record SeriesCopies(Guid[] All, Guid[] Mine);

        // A season's episode numbers under the series' copies: every one, and the ones the user may open.
        private sealed record SeasonEpisodes(EpisodeNumberSet All, EpisodeNumberSet Mine);

        // Keep combined files as ranges: privacy checks cover every episode without expanding them.
        private sealed class EpisodeNumberSet
        {
            private readonly List<EpisodeRange> _ranges = new();

            /// <summary>True when no episode numbers or ranges are present.</summary>
            public bool IsEmpty => _ranges.Count == 0;

            /// <summary>Adds a single episode or a combined file's full range.</summary>
            public void Add(int first, int? last)
            {
                _ranges.Add(new EpisodeRange(first, last));
            }

            /// <summary>True when a single number or a range covers the episode.</summary>
            public bool Contains(int number)
                => _ranges.Any(r => r.Contains(number));
        }

        /// <inheritdoc />
        public IReadOnlyCollection<string> Visible(Guid userId, bool isAdmin, IReadOnlyList<ArrFeedChange> changes, IReadOnlySet<string>? askedFor = null, ICollection<string>? absent = null)
        {
            if (changes.Count == 0) return Array.Empty<string>();
            // Request-list keys reach their owner only; everything else is a title key.
            var own = new List<string>();
            var titles = new List<ArrFeedChange>(changes.Count);
            foreach (var change in changes)
            {
                if (ArrTitleKey.TryParseUserRequests(change.Key, out var owner) || ArrTitleKey.TryParseUserInbox(change.Key, out owner))
                {
                    if (owner == userId) own.Add(change.Key);
                }
                else if (change.Key == ArrTitleKey.RequestsState)
                {
                    own.Add(change.Key);
                }
                else if (change.Key == ArrTitleKey.AdminOps)
                {
                    if (isAdmin) own.Add(change.Key);
                }
                else
                {
                    titles.Add(change);
                }
            }
            if (isAdmin && (!ArrInstanceLibraries.AbsentParentalEnabled || _view.Viewer(userId)?.HasParentalLimit != true)) return own.Concat(titles.Select(c => c.Key)).ToList();
            if (titles.Count == 0) return own;
            changes = titles;
            var user = Helpers.ArrCaller.Find(userId, _userManager);
            if (user == null || user.HasPermission(PermissionKind.IsDisabled)) return own;
            if (_cache.Count > MaxCacheEntries) _cache.Clear();
            if (_series.Count > MaxCacheEntries) _series.Clear();
            if (_seasons.Count > MaxCacheEntries) _seasons.Clear();

            var now = _now();
            // What every answer depends on besides the key: a change to any of it decides afresh. The policy revision
            // is the one of the user the answers are decided with (not another read, which a change could land
            // between: answers decided with the old user would be kept under the new revision).
            var stamp = Acquire.ArrJellyfinView.PolicyRevisionOf(user)
                + "|" + _view.Revision.ToString(CultureInfo.InvariantCulture)
                + "|" + RegistryStamp()
                + "|" + _libraries.Revision
                + "|" + (_requests?.Revision ?? 0).ToString(CultureInfo.InvariantCulture);
            var visible = own;
            foreach (var change in changes)
            {
                if (!ArrTitleKey.TryParse(change.Key, out var type, out var id, out _, out _)) continue;
                var asked = askedFor != null && askedFor.Contains(type == "movie" ? ArrTitleKey.Movie(id) : ArrTitleKey.Series(id));
                var shown = false;
                var wantsProof = false;
                foreach (var source in change.AllSources)
                {
                    var v = Cached(user, change.Key, source, now, stamp);
                    if (v == Verdict.Visible || (asked && v == Verdict.Absent))
                    {
                        shown = true;
                        break;
                    }
                    wantsProof |= v == Verdict.Absent;
                }
                if (shown) visible.Add(change.Key);
                else if (wantsProof) absent?.Add(change.Key);
            }
            return visible;
        }

        // Registry and library snapshots: changing either invalidates cached alias decisions.
        private string RegistryStamp()
        {
            var all = _store.Registry.All();
            var snapshots = all.SelectMany(i => new object?[] { _store.PeekLibrary(i.Id), _store.PeekQueue(i.Id), _store.PeekHistory(i.Id) }).ToArray();
            var known = _registryStamp;
            if (known != null && ReferenceEquals(known.Instances, all) && known.Snapshots.Length == snapshots.Length
                && known.Snapshots.Zip(snapshots).All(p => ReferenceEquals(p.First, p.Second))) return known.Stamp;
            var stamp = Guid.NewGuid().ToString("N");
            _registryStamp = new AliasInputs(all, snapshots, stamp);
            return stamp;
        }

        private static bool Fresh(DateTimeOffset at, string entryStamp, DateTimeOffset now, string stamp)
            => now - at < CacheTtl && string.Equals(entryStamp, stamp, StringComparison.Ordinal);

        private Verdict Cached(User user, string key, string? instanceId, DateTimeOffset now, string stamp)
        {
            var cacheKey = (user.Id, key, instanceId);
            if (_cache.TryGetValue(cacheKey, out var hit) && Fresh(hit.At, hit.Stamp, now, stamp)) return hit.Verdict;
            var verdict = Decide(user, key, instanceId, now, stamp);
            _cache[cacheKey] = (verdict, now, stamp);
            return verdict;
        }

        private Verdict Decide(User user, string key, string? instanceId, DateTimeOffset now, string stamp)
        {
            if (!ArrTitleKey.TryParse(key, out var type, out var id, out var season, out var episode)) return Verdict.Hidden;
            if (season != null)
            {
                // The series first (cached): a hidden series hides all of it; one not in Jellyfin
                // (its parts aren't either) keeps its answer.
                var series = Cached(user, ArrTitleKey.Series(id), instanceId, now, stamp);
                if (series == Verdict.Hidden) return Verdict.Hidden;
                try
                {
                    return DecidePart(user, id, season.Value, episode, now, stamp) ? series : Verdict.Hidden;
                }
                catch (Exception)
                {
                    return Verdict.Hidden;
                }
            }

            var kind = type == "movie" ? BaseItemKind.Movie : BaseItemKind.Series;
            var title = TitleKey.Parse(type == "movie" ? ArrTitleKey.Movie(id) : ArrTitleKey.Series(id))!;
            try
            {
                if (Find(new InternalItemsQuery(user), kind, title).Count > 0) return Verdict.Visible;
                if (Find(new InternalItemsQuery(), kind, title).Count > 0) return Verdict.Hidden;
            }
            catch (Exception)
            {
                return Verdict.Hidden;
            }
            // Absent titles require a verified rating before ownership can grant destination access.
            var viewer = _view.Viewer(user.Id) ?? new StatusViewer { UserId = user.Id, HasParentalLimit = !Unrestricted(user), Handle = user };
            var parentalKey = new[] { title }.Concat(_aliases.Of(title)).FirstOrDefault(k => k.Provider == "tmdb") ?? title;
            if (ArrInstanceLibraries.AbsentParentalEnabled && !_libraries.MaySeeAbsent(viewer, parentalKey)) return Verdict.Hidden;
            // Not in Jellyfin: ownership grants the destination exception.
            // "Asked" includes a request deleted in the last few minutes: its own announcement is
            // decided after the list no longer has it.
            var keys = new[] { title }.Concat(_aliases.Of(title)).ToList();
            if (_requests != null && keys.Any(k => _requests.AskedLatelyBy(k, user.Id))) return Verdict.Visible;
            if (!ArrInstanceLibraries.AbsentParentalEnabled && !Unrestricted(user)) return Verdict.Absent;

            var instances = (instanceId != null
                ? new[] { instanceId }
                : Holders(type == "movie" ? ArrKind.Radarr : ArrKind.Sonarr, id)).ToList();
            // A title only Seerr knows (no arr holds it yet): its request changes (approved, declined)
            // reach every member without content limits, who can already read its status by key
            // ("Asked by someone in your household").
            if (instanceId == null && instances.Count == 0) return ArrInstanceLibraries.CanOpenEveryLibrary(user, _libraries.Libraries()) && _requests != null && keys.Any(_requests.RequestedLately) ? Verdict.Visible : Verdict.Absent;
            return instances.Any(i => _store.Registry.Get(i) is { } instance &&
                ArrInstanceLibraries.CanOpen(user, _libraries.ResolveTitle(instance, title), _libraries.Libraries())) ? Verdict.Visible : Verdict.Absent;
        }

        // A season or episode of a series the user may hear about: the item itself when Jellyfin
        // has it (its own rating and tags may hide it), the series' answer otherwise. The user's
        // lookup runs only under the series copies the user can open: with ancestors set, Jellyfin
        // doesn't limit a user's query to their libraries, so another library's copy of the series
        // would otherwise answer for them.
        private bool DecidePart(User user, int tvdbId, int season, int? episode, DateTimeOffset now, string stamp)
        {
            var copies = Copies(user, tvdbId, now, stamp);
            if (copies.All.Length == 0) return true;   // not in Jellyfin: the series' answer stands
            if (episode is int e)
            {
                var episodes = Episodes(user, tvdbId, season, copies, now, stamp);
                return episodes.Mine.Contains(e) || !episodes.All.Contains(e);
            }
            if (copies.Mine.Length > 0 && FindSeason(new InternalItemsQuery(user), copies.Mine, season)) return true;
            return !FindSeason(new InternalItemsQuery(), copies.All, season);
        }

        // The series' Jellyfin copies (once per user and series while the answers hold).
        private SeriesCopies Copies(User user, int tvdbId, DateTimeOffset now, string stamp)
        {
            var key = (user.Id, tvdbId);
            if (_series.TryGetValue(key, out var hit) && Fresh(hit.At, hit.Stamp, now, stamp)) return hit.Copies;
            var title = TitleKey.Parse(ArrTitleKey.Series(tvdbId))!;
            var all = Find(new InternalItemsQuery(), BaseItemKind.Series, title, limit: 10).Select(i => i.Id).ToArray();
            var mine = all.Length == 0 ? Array.Empty<Guid>() : Find(new InternalItemsQuery(user), BaseItemKind.Series, title, limit: 10).Select(i => i.Id).ToArray();
            var copies = new SeriesCopies(all, mine);
            _series[key] = (copies, now, stamp);
            return copies;
        }

        // A season's episode numbers in Jellyfin, every one and the user's (two queries per season).
        private SeasonEpisodes Episodes(User user, int tvdbId, int season, SeriesCopies copies, DateTimeOffset now, string stamp)
        {
            var key = (user.Id, tvdbId, season);
            if (_seasons.TryGetValue(key, out var hit) && Fresh(hit.At, hit.Stamp, now, stamp)) return hit.Episodes;
            var all = EpisodeNumbers(new InternalItemsQuery(), copies.All, season);
            var mine = copies.Mine.Length == 0 || all.IsEmpty ? new EpisodeNumberSet() : EpisodeNumbers(new InternalItemsQuery(user), copies.Mine, season);
            var episodes = new SeasonEpisodes(all, mine);
            _seasons[key] = (episodes, now, stamp);
            return episodes;
        }

        private EpisodeNumberSet EpisodeNumbers(InternalItemsQuery query, Guid[] seriesIds, int season)
        {
            query.AncestorIds = seriesIds;
            query.Recursive = true;
            query.IncludeItemTypes = new[] { BaseItemKind.Episode };
            query.ParentIndexNumber = season;
            var numbers = new EpisodeNumberSet();
            foreach (var item in _libraryManager.GetItemList(query))
            {
                if (item.IndexNumber is not int first) continue;
                numbers.Add(first, (item as Episode)?.IndexNumberEnd);
            }
            return numbers;
        }

        private bool FindSeason(InternalItemsQuery query, Guid[] seriesIds, int season)
        {
            query.AncestorIds = seriesIds;
            query.Recursive = true;
            query.Limit = 1;
            query.IncludeItemTypes = new[] { BaseItemKind.Season };
            query.IndexNumber = season;
            return _libraryManager.GetItemList(query).Count > 0;
        }

        // The same alias set and provider query packing as IArrJellyfinView.Copies. These raw
        // queries keep H3's batched, unrestricted and user-scoped season checks separate.
        private IReadOnlyList<BaseItem> Find(InternalItemsQuery query, BaseItemKind kind, TitleKey title, int limit = 1)
        {
            query.IncludeItemTypes = new[] { kind };
            query.Recursive = true;
            query.Limit = limit;
            var found = new Dictionary<Guid, BaseItem>();
            foreach (var providers in TitleAliases.ProviderQueries(title, _aliases.Of(title)))
            {
                query.HasAnyProviderId = providers;
                foreach (var item in _libraryManager.GetItemList(query)) found.TryAdd(item.Id, item);
            }
            return found.Values.ToList();
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
        // access, which the shared destination resolver decides). Titles not in Jellyfin have no rating or tags
        // to check, so a user with any such limit hears only about titles Jellyfin can check.
        /// <summary>
        /// True when titles Jellyfin doesn't have yet may be hidden from <paramref name="user"/> for
        /// want of proof they asked for them: a content limit of any kind, or not every library.
        /// A user with neither sees every such title anyway.
        /// </summary>
        public static bool NeedsAskedProof(User user)
            => !Unrestricted(user) || !user.HasPermission(PermissionKind.EnableAllFolders);

        private static bool Unrestricted(User user)
            => user.MaxParentalRatingScore == null
               && NoneSet(user.GetPreference(PreferenceKind.BlockedTags))
               && NoneSet(user.GetPreference(PreferenceKind.AllowedTags))
               && user.GetPreferenceValues<UnratedItem>(PreferenceKind.BlockUnratedItems).Length == 0;

        private static bool NoneSet(string[]? values) => (values ?? Array.Empty<string>()).All(string.IsNullOrWhiteSpace);

    }
}
