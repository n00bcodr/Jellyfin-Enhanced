using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import
{
    /// <summary>
    /// What the library itself holds of a title for one viewer, as the import review needs it (review round 1,
    /// 4C2-SEC-02): copies exist and the viewer can open none of them (<see cref="Hidden"/>), and the seasons and episodes
    /// (of the season asked for) the library has but the viewer can't open. An import candidate, alternative or source entry
    /// that stands for any of these is never offered as a title that isn't in the library.
    /// </summary>
    /// <param name="Hidden">Copies exist and the viewer can open none of them (or the library can't be read).</param>
    /// <param name="HiddenSeasons">Season numbers the viewer can't open.</param>
    /// <param name="HiddenEpisodes">Episode numbers of the season asked for that the viewer can't open.</param>
    public sealed record ImportPhysical(bool Hidden, IReadOnlySet<int> HiddenSeasons, IReadOnlySet<int> HiddenEpisodes)
    {
        /// <summary>Nothing held anywhere: nothing hidden.</summary>
        public static readonly ImportPhysical None = new(false, new HashSet<int>(), new HashSet<int>());

        /// <summary>The library can't be read: everything counts as hidden (fails closed).</summary>
        public static readonly ImportPhysical Unreadable = new(true, new HashSet<int>(), new HashSet<int>());

        /// <summary>True when a scope (the title; a season; episodes of a season) is held but not open to the viewer.</summary>
        /// <param name="season">Season of a season or episodes scope.</param>
        /// <param name="episodes">Episode numbers of an episodes scope.</param>
        /// <returns>True when hidden.</returns>
        public bool Hides(int? season, IEnumerable<int>? episodes) =>
            Hidden || (season is int s && (HiddenSeasons.Contains(s) || (episodes?.Any(HiddenEpisodes.Contains) ?? false)));

        /// <summary>The import view of a native-details physical title.</summary>
        /// <param name="title">Physical title.</param>
        /// <returns>The import view.</returns>
        public static ImportPhysical From(PhysicalTitle title) => new(title.Hidden, title.HiddenSeasons, title.HiddenEpisodes);
    }

    /// <summary>
    /// The ids an import candidate or source entry carries (review round 2, D53 rule 2: identity by every known id): the
    /// input of <see cref="CompletedIdentity.Completion"/>, which completes it once into the <see cref="CompletedIdentity"/>
    /// every consumer takes (no consumer takes this raw form).
    /// </summary>
    /// <param name="Movie">Movie (else series).</param>
    /// <param name="Tmdb">TMDB id.</param>
    /// <param name="Tvdb">TVDB id (series only).</param>
    /// <param name="Imdb">IMDb id (the title's, never an episode's).</param>
    public sealed record ImportIdentity(bool Movie, int? Tmdb, int? Tvdb, string? Imdb)
    {
        /// <summary>The title keys of the usable ids.</summary>
        public IReadOnlyList<TitleKey> Keys => TitleAliases.FromProviderIds(
            Movie,
            Tmdb is > 0 ? Tmdb.Value.ToString(CultureInfo.InvariantCulture) : null,
            !Movie && Tvdb is > 0 ? Tvdb.Value.ToString(CultureInfo.InvariantCulture) : null,
            Imdb);

        /// <summary>The providers of the usable ids ("tmdb", "tvdb", "imdb").</summary>
        public IReadOnlyCollection<string> Providers => Keys.Select(k => k.Provider).Distinct().ToList();

        /// <summary>Every id a library copy could carry is known (movie: TMDB and IMDb; series: TMDB, TVDB and IMDb).</summary>
        public bool Full => Providers.Count == (Movie ? 2 : 3);

        /// <summary>This identity with the ids it lacks filled in.</summary>
        /// <param name="tmdb">TMDB id.</param>
        /// <param name="tvdb">TVDB id.</param>
        /// <param name="imdb">IMDb id.</param>
        /// <returns>The completed identity.</returns>
        public ImportIdentity With(int? tmdb, int? tvdb, string? imdb) => this with
        {
            Tmdb = Tmdb is > 0 ? Tmdb : tmdb,
            Tvdb = Movie ? null : Tvdb is > 0 ? Tvdb : tvdb,
            Imdb = Keys.Any(k => k.Provider == "imdb") ? Imdb : imdb,
        };

        /// <summary>A stable text of the usable ids (a cache key).</summary>
        /// <returns>The text.</returns>
        public string Text() => (Movie ? "m:" : "t:") + string.Join(',', Keys.Select(k => k.ToString()).OrderBy(k => k, StringComparer.Ordinal));
    }

    /// <summary>Reads <see cref="ImportPhysical"/> for a viewer (the import review's physical-title projection).</summary>
    public interface IImportPhysicalTitles
    {
        /// <summary>What the library holds of a title for the viewer, asked under every id of <paramref name="identity"/>.</summary>
        /// <param name="viewer">The viewer.</param>
        /// <param name="identity">The title's completed identity (every id it is known by).</param>
        /// <param name="season">The season whose episodes are wanted, or null.</param>
        /// <returns>The physical title (<see cref="ImportPhysical.Unreadable"/> when the library can't be read).</returns>
        ImportPhysical Read(User viewer, CompletedIdentity identity, int? season);

        /// <summary>
        /// True when the library holds copies of this kind of title (movies or series) that carry none of
        /// <paramref name="identity"/>'s ids, so asking under those ids alone can't find every copy (true when the library
        /// can't be asked).
        /// </summary>
        /// <param name="identity">The ids at hand.</param>
        /// <returns>True when the identity must be completed before the library is asked.</returns>
        bool HoldsCopiesBeyond(ImportIdentity identity);
    }

    /// <summary>
    /// <see cref="IImportPhysicalTitles"/> over the native details' library reader: on Jellyfin 12 through
    /// <see cref="NativeDetailsPolicy"/> (the native pages' own projection and cache revision), on 10.11 through
    /// <see cref="NativeDetailsLibrary"/> with the viewer's policy revision. The same answer whether Seerr is set up or
    /// not (no Seerr input); a library that can't be read hides.
    /// </summary>
    public sealed class LibraryImportPhysicalTitles : IImportPhysicalTitles
    {
#if JF12
        private readonly NativeDetailsPolicy _policy;

        /// <summary>Creates the reader.</summary>
        /// <param name="policy">The native details policy.</param>
        public LibraryImportPhysicalTitles(NativeDetailsPolicy policy)
        {
            _policy = policy;
        }

        /// <inheritdoc />
        public ImportPhysical Read(User viewer, CompletedIdentity identity, int? season)
        {
            try
            {
                return ImportPhysical.From(_policy.Physical(viewer, identity.Movie, identity.Keys, season));
            }
            catch (Exception)
            {
                return ImportPhysical.Unreadable;
            }
        }

        /// <inheritdoc />
        public bool HoldsCopiesBeyond(ImportIdentity identity) => _policy.HoldsCopiesWithout(identity.Movie, identity.Providers);
#else
        private readonly NativeDetailsLibrary _library;
        private readonly IArrJellyfinView _view;

        /// <summary>Creates the reader.</summary>
        /// <param name="library">The library reader.</param>
        /// <param name="view">Viewer policy revisions.</param>
        public LibraryImportPhysicalTitles(NativeDetailsLibrary library, IArrJellyfinView view)
        {
            _library = library;
            _view = view;
        }

        /// <inheritdoc />
        public ImportPhysical Read(User viewer, CompletedIdentity identity, int? season)
        {
            try
            {
                // An unknown revision never shares a cache entry with another policy.
                var revision = _view.Viewer(viewer.Id)?.PolicyRevision ?? Guid.NewGuid().ToString("N");
                return ImportPhysical.From(_library.Read(viewer, revision, identity.Movie, identity.Keys, season));
            }
            catch (Exception)
            {
                return ImportPhysical.Unreadable;
            }
        }

        /// <inheritdoc />
        public bool HoldsCopiesBeyond(ImportIdentity identity)
        {
            try
            {
                return _library.HoldsCopiesWithout(identity.Movie, identity.Providers);
            }
            catch (Exception)
            {
                return true;
            }
        }
#endif
    }

    /// <summary>
    /// The physical-title projection of one import call or source read for one viewer (review rounds 2 and 3, D53 rule
    /// 2), shared by the resolver's candidates and alternatives and the source preview's entries. It takes only a
    /// <see cref="CompletedIdentity"/> (completed once, on the candidate or entry, before any consumer runs), so the
    /// library is asked under every id the title is known by. One library read per identity and season.
    /// </summary>
    internal sealed class ImportPhysicalProjection
    {
        private readonly IImportPhysicalTitles _physical;
        private User _viewer = null!;
        private Dictionary<string, ImportPhysical> _reads = new(StringComparer.Ordinal);

        /// <summary>Creates the projection.</summary>
        /// <param name="physical">The library reader.</param>
        /// <param name="viewer">The viewer.</param>
        public ImportPhysicalProjection(IImportPhysicalTitles physical, User viewer)
        {
            using var __factsOperation0 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            _physical = physical;
            _viewerFacts = viewer;
        }

        /// <summary>What the library holds of the title for the viewer.</summary>
        /// <param name="identity">The title's completed identity.</param>
        /// <param name="season">The season whose episodes are wanted, or null.</param>
        /// <returns>The physical title.</returns>
        public ImportPhysical Read(CompletedIdentity identity, int? season)
        {
            using var __factsOperation1 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            if (identity.Keys.Count == 0)
            {
                return ImportPhysical.None; // no id: nothing in the library is held under it
            }

            var key = identity.Text() + "|" + (season?.ToString(CultureInfo.InvariantCulture) ?? "-");
            if (!_readsFacts.TryGetValue(key, out var physical))
            {
                _readsFacts[key] = physical = _physical.Read(_viewerFacts, identity, season);
            }

            return physical;
        }
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<Dictionary<string, ImportPhysical>> _readsFactsOwner = new();
        private Dictionary<string, ImportPhysical> _readsFacts { get => _readsFactsOwner.Read(ref _reads, () => new(StringComparer.Ordinal)); set => _readsFactsOwner.Store(ref _reads, value); }
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<User> _viewerFactsOwner = new(prepared: true);
        private User _viewerFacts { get => _viewerFactsOwner.Read(ref _viewer, () => default!); set => _viewerFactsOwner.Store(ref _viewer, value); }
    }
}
