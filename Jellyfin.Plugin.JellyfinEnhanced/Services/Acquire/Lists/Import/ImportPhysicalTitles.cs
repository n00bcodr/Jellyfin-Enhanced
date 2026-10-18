using System;
using System.Collections.Generic;
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

    /// <summary>Reads <see cref="ImportPhysical"/> for a viewer (the import review's physical-title projection).</summary>
    public interface IImportPhysicalTitles
    {
        /// <summary>What the library holds of a title for the viewer.</summary>
        /// <param name="viewer">The viewer.</param>
        /// <param name="movie">Movie (else series).</param>
        /// <param name="tmdb">TMDB id.</param>
        /// <param name="season">The season whose episodes are wanted, or null.</param>
        /// <returns>The physical title (<see cref="ImportPhysical.Unreadable"/> when the library can't be read).</returns>
        ImportPhysical Read(User viewer, bool movie, int tmdb, int? season);
    }

    /// <summary>
    /// <see cref="IImportPhysicalTitles"/> over the native details' library reader: on Jellyfin 12 through
    /// <see cref="NativeDetailsPolicy.Physical(User, bool, int, int?, bool)"/> (the native pages' own projection and cache
    /// revision), on 10.11 through <see cref="NativeDetailsLibrary"/> with the viewer's policy revision. The same answer
    /// whether Seerr is set up or not (no Seerr input); a library that can't be read hides.
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
        public ImportPhysical Read(User viewer, bool movie, int tmdb, int? season)
        {
            try
            {
                return ImportPhysical.From(_policy.Physical(viewer, movie, tmdb, season));
            }
            catch (Exception)
            {
                return ImportPhysical.Unreadable;
            }
        }
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
        public ImportPhysical Read(User viewer, bool movie, int tmdb, int? season)
        {
            try
            {
                // An unknown revision never shares a cache entry with another policy.
                var revision = _view.Viewer(viewer.Id)?.PolicyRevision ?? Guid.NewGuid().ToString("N");
                return ImportPhysical.From(_library.Read(viewer, revision, movie, tmdb, season));
            }
            catch (Exception)
            {
                return ImportPhysical.Unreadable;
            }
        }
#endif
    }
}
