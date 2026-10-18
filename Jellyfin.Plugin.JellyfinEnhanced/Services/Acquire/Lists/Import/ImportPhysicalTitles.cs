using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
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
    /// Every id an import candidate or source entry is known by (review round 2, D53 rule 2: identity by every known id).
    /// The physical-title check is asked under all of them, so a copy held only under its TVDB or IMDb id is found too.
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
        /// <param name="identity">Every id the title is known by.</param>
        /// <param name="season">The season whose episodes are wanted, or null.</param>
        /// <returns>The physical title (<see cref="ImportPhysical.Unreadable"/> when the library can't be read).</returns>
        ImportPhysical Read(User viewer, ImportIdentity identity, int? season);

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
        public ImportPhysical Read(User viewer, ImportIdentity identity, int? season)
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
        public ImportPhysical Read(User viewer, ImportIdentity identity, int? season)
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
    /// The physical-title projection of one import call for one viewer (review round 2, D53 rule 2), shared by the
    /// resolver's candidates and alternatives and the source preview's entries. The library is asked under every id the
    /// candidate or entry carries; when the library holds copies those ids can't find (copies without any of them: a
    /// library tagged by TVDB only, say), the identity is completed first through the title lookup (TMDB details:
    /// external ids; an IMDb/TVDB id: its TMDB title), so a copy held under any id is found. One library read per
    /// identity and season; one completion per identity.
    /// </summary>
    internal sealed class ImportPhysicalProjection
    {
        private readonly IImportPhysicalTitles _physical;
        private readonly IImportLookup? _lookup;
        private readonly User _viewer;
        private readonly ImportCallContext _context;
        private readonly Dictionary<string, ImportPhysical> _reads = new(StringComparer.Ordinal);
        private readonly Dictionary<string, ImportIdentity?> _identities = new(StringComparer.Ordinal);
        private readonly Dictionary<string, bool> _beyond = new(StringComparer.Ordinal);

        /// <summary>Creates the projection.</summary>
        /// <param name="physical">The library reader.</param>
        /// <param name="lookup">The title lookup (null: identities can't be completed, so a gap hides).</param>
        /// <param name="viewer">The viewer.</param>
        /// <param name="context">The call's lookup context.</param>
        public ImportPhysicalProjection(IImportPhysicalTitles physical, IImportLookup? lookup, User viewer, ImportCallContext context)
        {
            _physical = physical;
            _lookup = lookup;
            _viewer = viewer;
            _context = context;
        }

        /// <summary>What the library holds of the title for the viewer; null when its ids couldn't be completed (a lookup failed).</summary>
        /// <param name="identity">The ids the candidate or entry carries.</param>
        /// <param name="season">The season whose episodes are wanted, or null.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The physical title, or null (the caller hides or retries).</returns>
        public async Task<ImportPhysical?> ReadAsync(ImportIdentity identity, int? season, CancellationToken cancellationToken)
        {
            var full = await CompleteAsync(identity, cancellationToken).ConfigureAwait(false);
            if (full == null)
            {
                return null;
            }

            if (full.Keys.Count == 0)
            {
                return ImportPhysical.None; // no id: nothing in the library is held under it
            }

            var key = full.Text() + "|" + (season?.ToString(CultureInfo.InvariantCulture) ?? "-");
            if (!_reads.TryGetValue(key, out var physical))
            {
                _reads[key] = physical = _physical.Read(_viewer, full, season);
            }

            return physical;
        }

        private async Task<ImportIdentity?> CompleteAsync(ImportIdentity identity, CancellationToken cancellationToken)
        {
            if (identity.Keys.Count == 0 || identity.Full)
            {
                return identity;
            }

            var key = identity.Text();
            if (_identities.TryGetValue(key, out var known))
            {
                return known;
            }

            var beyondKey = (identity.Movie ? "m:" : "t:") + string.Join(',', identity.Providers.OrderBy(p => p, StringComparer.Ordinal));
            if (!_beyond.TryGetValue(beyondKey, out var beyond))
            {
                _beyond[beyondKey] = beyond = _physical.HoldsCopiesBeyond(identity);
            }

            // Every copy of this kind carries one of the ids at hand: they find every copy as they are.
            var completed = beyond ? await LookupAsync(identity, cancellationToken).ConfigureAwait(false) : identity;
            _identities[key] = completed;
            return completed;
        }

        private async Task<ImportIdentity?> LookupAsync(ImportIdentity identity, CancellationToken cancellationToken)
        {
            if (_lookup == null)
            {
                return null;
            }

            var type = identity.Movie ? "movie" : "tv";
            var tmdb = identity.Tmdb is > 0 ? identity.Tmdb : null;
            if (tmdb == null)
            {
                var query = identity.Imdb != null ? "imdb:" + identity.Imdb : "tvdb:" + identity.Tvdb!.Value.ToString(CultureInfo.InvariantCulture);
                var hits = await _lookup.SearchAsync(query, _context, cancellationToken).ConfigureAwait(false);
                if (hits.Status == LookupStatus.Transient)
                {
                    return null;
                }

                tmdb = hits.Value?.FirstOrDefault(h => h.MediaType == type)?.TmdbId;
                if (tmdb is not > 0)
                {
                    return identity; // the lookup doesn't know the title: these are all its ids
                }
            }

            var details = await _lookup.GetDetailsAsync(type, tmdb.Value, _context, cancellationToken).ConfigureAwait(false);
            return details.Status switch
            {
                LookupStatus.Transient => null,
                _ => identity.With(tmdb, details.Value?.TvdbId, details.Value?.ImdbId),
            };
        }
    }
}
