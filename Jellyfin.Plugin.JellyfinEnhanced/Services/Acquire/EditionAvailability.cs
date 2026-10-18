using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>The edition of a title a request, a page or a list entry is about.</summary>
    public enum Edition
    {
        /// <summary>
        /// The standard copy: any playable source by default (a 4K one included), or only a source known not to be
        /// 4K when the administrator turns on <see cref="PluginConfiguration.ArrStandardNeedsNonFourK"/>.
        /// </summary>
        Standard,

        /// <summary>The 4K copy: a playable source with 4K dimensions (<see cref="EditionAvailability.IsFourK"/>).</summary>
        FourK,
    }

    /// <summary>
    /// One source that qualifies for an edition: the copy it is in (the movie item, or the series item an episode
    /// belongs to), the movie or episode item the viewer opens, its numbers (episodes) and the source itself.
    /// </summary>
    /// <param name="CopyId">The movie item, or the episode's own series item.</param>
    /// <param name="ItemId">The movie or episode item.</param>
    /// <param name="Season">Season number (episodes).</param>
    /// <param name="Episode">Episode number (episodes).</param>
    /// <param name="EpisodeEnd">Last episode number of a multi-episode file.</param>
    /// <param name="Source">The qualifying source.</param>
    public sealed record EditionHit(Guid CopyId, Guid ItemId, int? Season, int? Episode, int? EpisodeEnd, JfSource Source)
    {
        /// <summary>The exact item that plays this version (a playlist or collection inserts it); <see cref="ItemId"/> is the logical item.</summary>
        public Guid PlayableItemId => Source.BackingItemId == Guid.Empty ? ItemId : Source.BackingItemId;

        /// <summary>An episode's own physical series item (never the grouped folder it was listed through); null for a movie.</summary>
        public Guid? SeriesId => Season.HasValue ? CopyId : null;

        /// <summary>True when this episode hit covers <paramref name="episode"/> of <paramref name="season"/>.</summary>
        public bool Covers(int season, int episode)
            => Season == season && Episode is int first && new EpisodeRange(first, EpisodeEnd).Contains(episode);
    }

    /// <summary>An edition's episodes across the copies a viewer can open: every qualifying source, by episode.</summary>
    public sealed class EpisodeEditions
    {
        internal EpisodeEditions(IReadOnlyList<EditionHit> hits)
        {
            Hits = hits;
        }

        /// <summary>Every qualifying source.</summary>
        public IReadOnlyList<EditionHit> Hits { get; }

        /// <summary>The qualifying sources of one episode (a multi-episode file covering it included).</summary>
        public IReadOnlyList<EditionHit> For(int season, int episode) => Hits.Where(h => h.Covers(season, episode)).ToList();

        /// <summary>True when the episode has a qualifying source.</summary>
        public bool Has(int season, int episode) => Hits.Any(h => h.Covers(season, episode));

        /// <summary>True when every episode <paramref name="first"/>..<paramref name="last"/> of the season has a qualifying source.</summary>
        public bool Covers(int season, int first, int last)
        {
            if (last < first) return false;
            for (var n = first; n <= last; n++)
            {
                if (!Has(season, n)) return false;
            }

            return true;
        }

        /// <summary>
        /// The episodes as the status composer counts files: one per episode item with a qualifying source (never
        /// virtual), dated when its first qualifying source arrived.
        /// </summary>
        public IReadOnlyList<JfEpisode> AsEpisodes()
            => Hits.Where(h => h.Season.HasValue && h.Episode.HasValue)
                .GroupBy(h => h.ItemId)
                .Select(g => new JfEpisode
                {
                    ItemId = g.Key,
                    Season = g.First().Season!.Value,
                    Episode = g.First().Episode!.Value,
                    EpisodeEnd = g.First().EpisodeEnd,
                    DateCreated = g.Select(h => h.Source.DateCreated).Where(d => d.HasValue).DefaultIfEmpty(null).Min(),
                })
                .ToList();
    }

    /// <summary>
    /// The one answer to "does the viewer have edition E of this scope": an ACCESSIBLE, PLAYABLE source that
    /// qualifies, judged per source (Jellyfin's media sources: one item can hold several versions) and per item,
    /// across every copy the viewer can open (separate libraries, the folders automatic series grouping presents as
    /// one show, each episode by its own sources), or only the copy a page is pinned to. Arr ownership, a shared
    /// folder or a library is never enough. Reads Jellyfin only (never an arr); works on 10.11 and 12.x (episode
    /// versions on one item are 12.x only; 10.11 lists them as more episode items, which count the same way).
    /// Status composition, request fulfilment and Get 4K use it; later surfaces (lists, badges, home rows, the
    /// hub) consume <see cref="Scope"/> and <see cref="Available"/>.
    /// </summary>
    public sealed class EditionAvailability
    {
        /// <summary>A video at least this wide is 4K (3840 UHD, 4096 DCI, cropped scope).</summary>
        public const int FourKMinWidth = 3200;

        /// <summary>A video at least this tall is 4K (a portrait or unusual width).</summary>
        public const int FourKMinHeight = 2000;

        private readonly IArrJellyfinView _view;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<TitleKey, StatusViewer, IReadOnlyList<JfCopy>> _copies;

        /// <summary>The service over a Jellyfin view, the settings and the title's copies (by key and aliases).</summary>
        /// <param name="view">Jellyfin.</param>
        /// <param name="config">Settings (the standard-edition switch).</param>
        /// <param name="copies">Every Jellyfin copy of a title as the viewer sees it.</param>
        public EditionAvailability(IArrJellyfinView view, Func<PluginConfiguration?> config, Func<TitleKey, StatusViewer, IReadOnlyList<JfCopy>> copies)
        {
            _view = view;
            _config = config;
            _copies = copies;
        }

        /// <summary>Every Jellyfin copy of a title (any library; <see cref="JfCopy.Visible"/> says whether the viewer can open it).</summary>
        /// <param name="viewer">The viewer.</param>
        /// <param name="title">The title (a season or episode key counts as its title).</param>
        /// <returns>The copies.</returns>
        public IReadOnlyList<JfCopy> TitleCopies(StatusViewer viewer, TitleKey title) => _copies(title.Title, viewer);

        /// <summary>True for 4K video dimensions (the same rule as the browser's Get 4K check).</summary>
        /// <param name="width">Width, or null when unknown.</param>
        /// <param name="height">Height, or null when unknown.</param>
        /// <returns>True when 4K.</returns>
        public static bool IsFourK(int? width, int? height) => (width ?? 0) >= FourKMinWidth || (height ?? 0) >= FourKMinHeight;

        /// <summary>
        /// Whether Jellyfin has read a source's dimensions. Until it has, the source is neither edition: not 4K, and never
        /// a source known not to be 4K (the same rule as <see cref="Stamps.AcquisitionCopyPolicy.Known"/>).
        /// </summary>
        /// <param name="width">Width, or null/0 when unknown.</param>
        /// <param name="height">Height, or null/0 when unknown.</param>
        /// <returns>True when read.</returns>
        public static bool DimensionsKnown(int? width, int? height) => (width ?? 0) > 0 || (height ?? 0) > 0;

        /// <summary>The edition a request for 4K (or not) asks for.</summary>
        public static Edition Of(bool fourK) => fourK ? Edition.FourK : Edition.Standard;

        /// <summary>A standard request needs a source known not to be 4K (the administrator's switch; off: any playable copy).</summary>
        public bool StandardNeedsNonFourK => _config()?.ArrStandardNeedsNonFourK == true;

        /// <summary>
        /// Whether one playable source qualifies for an edition. 4K needs 4K dimensions. Standard takes any source,
        /// or with <see cref="StandardNeedsNonFourK"/> one whose dimensions Jellyfin has read and aren't 4K (a file
        /// Jellyfin hasn't read yet may still be 4K, and a request closed on it would be closed for good).
        /// </summary>
        public bool Qualifies(JfSource source, Edition edition) => edition switch
        {
            Edition.FourK => IsFourK(source.Width, source.Height),
            _ => !StandardNeedsNonFourK || (DimensionsKnown(source.Width, source.Height) && !IsFourK(source.Width, source.Height)),
        };

        /// <summary>
        /// The qualifying sources of a movie across <paramref name="copies"/> the viewer can open, or only in the
        /// copy <paramref name="pinned"/> names (nothing when they can't open that one: never another copy).
        /// <paramref name="readDimensions"/> false reads each copy's own file only, without its versions' dimensions
        /// (only for a standard edition that takes any playable copy; a placeholder or missing item still has none).
        /// </summary>
        public IReadOnlyList<EditionHit> Movie(StatusViewer viewer, IReadOnlyList<JfCopy> copies, Edition edition, Guid? pinned = null, bool readDimensions = true)
        {
            var hits = new List<EditionHit>();
            foreach (var copy in Openable(copies, pinned))
            {
                foreach (var source in _view.Sources(copy.ItemId, viewer, readDimensions))
                {
                    if (Qualifies(source, edition)) hits.Add(new EditionHit(copy.ItemId, source.ItemId, null, null, null, source));
                }
            }

            return Preferred(hits, edition);
        }

        /// <summary>
        /// The hits in the order to use them: a standard edition prefers a source known not to be 4K (a request for the
        /// standard copy plays the standard file when there is one), the copies' and sources' own order otherwise.
        /// </summary>
        private static List<EditionHit> Preferred(List<EditionHit> hits, Edition edition)
            => edition == Edition.Standard ? hits.OrderBy(h => IsFourK(h.Source.Width, h.Source.Height) || !DimensionsKnown(h.Source.Width, h.Source.Height) ? 1 : 0).ToList() : hits;

        /// <summary>
        /// The qualifying episode sources of a series (one season, or all) across the series copies the viewer can
        /// open, each episode by its own sources in its own series item (so the folder automatic grouping lists
        /// with another never lends it an episode), or only in the series item <paramref name="pinned"/> names.
        /// <paramref name="readDimensions"/> false skips reading the sources' dimensions (only for a standard edition
        /// that takes any playable copy; with it, unread sources never qualify for 4K or a non-4K standard edition).
        /// </summary>
        public EpisodeEditions Episodes(StatusViewer viewer, IReadOnlyList<JfCopy> seriesCopies, Edition edition, int? season, Guid? pinned = null, bool readDimensions = true)
        {
            var hits = new List<EditionHit>();
            foreach (var copy in Openable(seriesCopies, pinned))
            {
                foreach (var episode in _view.EpisodeSources(copy.ItemId, season, viewer, readDimensions))
                {
                    foreach (var source in episode.Sources)
                    {
                        if (Qualifies(source, edition)) hits.Add(new EditionHit(copy.ItemId, episode.ItemId, episode.Season, episode.Episode, episode.EpisodeEnd, source));
                    }
                }
            }

            return new EpisodeEditions(Preferred(hits, edition));
        }

        /// <summary>
        /// The qualifying sources for one scope: a movie, a whole series (any episode), a season, or an episode
        /// (a multi-episode file covering it included), across every copy the viewer can open or only the pinned
        /// copy (a movie item, or the series item of a season or episode page). Never calls an arr.
        /// </summary>
        public IReadOnlyList<EditionHit> Scope(StatusViewer viewer, TitleKey scope, Edition edition, Guid? pinned = null)
        {
            var copies = _copies(scope.Title, viewer);
            if (scope.IsMovie) return Movie(viewer, copies, edition, pinned);
            var episodes = Episodes(viewer, copies, edition, scope.Season, pinned);
            return scope.Season is int s && scope.Episode is int e ? episodes.For(s, e) : episodes.Hits;
        }

        /// <summary>
        /// The qualifying sources for one scope that EVERY one of <paramref name="viewers"/> can open (a shared list's
        /// audience): the hits of the first viewer whose exact playable item each other viewer's hits hold too. No
        /// viewers: the server's library context (<see cref="StatusViewer.Library"/>, no access filter).
        /// </summary>
        public IReadOnlyList<EditionHit> ScopeForAll(IReadOnlyList<StatusViewer> viewers, TitleKey scope, Edition edition, Guid? pinned = null)
        {
            if (viewers.Count == 0) return Scope(StatusViewer.Library, scope, edition, pinned);
            var first = Scope(viewers[0], scope, edition, pinned);
            foreach (var other in viewers.Skip(1))
            {
                if (first.Count == 0) break;
                var theirs = new HashSet<Guid>(Scope(other, scope, edition, pinned).Select(h => h.PlayableItemId));
                first = first.Where(h => theirs.Contains(h.PlayableItemId)).ToList();
            }

            return first;
        }

        /// <summary>True when the scope has a qualifying source (see <see cref="Scope"/>).</summary>
        public bool Available(StatusViewer viewer, TitleKey scope, Edition edition, Guid? pinned = null) => Scope(viewer, scope, edition, pinned).Count > 0;

        /// <summary>True when every episode of an episode range has a qualifying source (see <see cref="Scope"/>).</summary>
        public bool AvailableRange(StatusViewer viewer, TitleKey series, int season, int first, int last, Edition edition, Guid? pinned = null)
            => !series.IsMovie && Episodes(viewer, _copies(series.Title, viewer), edition, season, pinned).Covers(season, first, last);

        private static IEnumerable<JfCopy> Openable(IReadOnlyList<JfCopy> copies, Guid? pinned)
            => copies.Where(c => c.Visible && (pinned is not Guid id || c.ItemId == id)).GroupBy(c => c.ItemId).Select(g => g.First());
    }
}
