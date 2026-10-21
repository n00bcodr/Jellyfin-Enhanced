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

        /// <summary>
        /// Whatever plays: any accessible playable source, whatever its dimensions (the whole title's Ready, a follow, "open
        /// in library"; never a request, which is <see cref="Standard"/> or <see cref="FourK"/>).
        /// </summary>
        Any,
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
        private EpisodeCoverage? _coverage;

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

        /// <summary>
        /// True when every episode <paramref name="first"/>..<paramref name="last"/> of the season has a qualifying source:
        /// the hits' ranges merged into intervals (overflow-safe endpoints), so the work follows the files, never the span.
        /// </summary>
        public bool Covers(int season, int first, int last) => last >= first && Coverage().ContainsRange(season, first, last);

        /// <summary>
        /// How many distinct episodes of the season have a qualifying source (D53, edition round 19: disjoint identities): the
        /// versions of one episode count once, a multi-episode file every episode it covers.
        /// </summary>
        public long CountInSeason(int season) => Coverage().CountInSeason(season);

        /// <summary>The hits as merged episode intervals per season.</summary>
        internal EpisodeCoverage Coverage()
            => _coverage ??= new EpisodeCoverage(Hits.Where(h => h.Season.HasValue && h.Episode.HasValue)
                .Select(h => new JfEpisode { Season = h.Season!.Value, Episode = h.Episode!.Value, EpisodeEnd = h.EpisodeEnd }));

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
    /// </summary>
    /// <remarks>
    /// D53, edition round 19 (one availability definition): EVERY decision that credits something as there reads this
    /// predicate, by whichever reference reaches it: a copy (movie item or series item: <see cref="Movie"/>,
    /// <see cref="Episodes"/>, <see cref="Holding"/>), a title key (<see cref="Scope"/>), one movie or episode item
    /// (<see cref="Item"/>), or, for <see cref="Edition.Any"/> only, an episode or item the view already read
    /// (<see cref="Plays(JfEpisode)"/>, <see cref="Plays(JfItemRef)"/>: the view's own "plays a file" fact, the same one
    /// its sources start from). Placeholders (a ".disc" stub), pathless and missing items have no source; a native
    /// ".strm" shortcut's remote source is its own item's, with the remote source's dimensions. Ownership (which arr's
    /// folder a file sits in) only selects arr facts; it never decides an edition.
    /// </remarks>
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

        /// <summary>
        /// The predicate over a Jellyfin view as every surface uses it (D53, edition round 21: one availability rule): a title's
        /// copies are the view's copies under the title's key and its aliases, as the viewer sees them.
        /// </summary>
        /// <param name="view">Jellyfin.</param>
        /// <param name="config">Settings.</param>
        /// <param name="aliases">The titles' other keys (null: the key alone).</param>
        /// <returns>The predicate.</returns>
        public static EditionAvailability Over(IArrJellyfinView view, Func<PluginConfiguration?> config, TitleAliases? aliases)
            => new(view, config, (key, viewer) => view.Copies(key, viewer, aliases?.Of(key)).Display);

        /// <summary>True for 4K video dimensions (the same rule as the browser's Get 4K check).</summary>
        /// <param name="width">Width, or null when unknown.</param>
        /// <param name="height">Height, or null when unknown.</param>
        /// <returns>True when 4K.</returns>
        public static bool IsFourK(int? width, int? height) => (width ?? 0) >= FourKMinWidth || (height ?? 0) >= FourKMinHeight;

        /// <summary>The edition a request for 4K (or not) asks for.</summary>
        public static Edition Of(bool fourK) => fourK ? Edition.FourK : Edition.Standard;

        /// <summary>A standard request needs a source known not to be 4K (the administrator's switch; off: any playable copy).</summary>
        public bool StandardNeedsNonFourK => _config()?.ArrStandardNeedsNonFourK == true;

        /// <summary>
        /// Every setting that changes what an edition answer is (D53, edition round 19: every response proven fresh), as one
        /// short text: a cached answer or a response gate that carries it is never served after one of them changed. Today the
        /// administrator's "Standard requests need a non-4K copy"; a new edition setting is added here, and only here.
        /// </summary>
        /// <param name="config">The settings.</param>
        public static string SemanticRevision(PluginConfiguration? config) => config?.ArrStandardNeedsNonFourK == true ? "s1" : "s0";

        /// <summary>
        /// Whether one playable source qualifies for an edition. 4K needs 4K dimensions. Standard takes any source,
        /// or with <see cref="StandardNeedsNonFourK"/> one whose dimensions Jellyfin has read and aren't 4K (a file
        /// Jellyfin hasn't read yet may still be 4K, and a request closed on it would be closed for good).
        /// </summary>
        public bool Qualifies(JfSource source, Edition edition) => edition switch
        {
            Edition.FourK => IsFourK(source.Width, source.Height),
            Edition.Any => true,
            _ => !StandardNeedsNonFourK || ((source.Width > 0 || source.Height > 0) && !IsFourK(source.Width, source.Height)),
        };

        /// <summary>Whether judging <paramref name="edition"/> needs the sources' dimensions (4K, or a standard edition that needs a non-4K copy).</summary>
        public bool NeedsDimensions(Edition edition) => edition == Edition.FourK || (edition == Edition.Standard && StandardNeedsNonFourK);

        /// <summary>
        /// <see cref="Edition.Any"/> for an episode the view already read (a series folder's episodes): one Jellyfin plays
        /// and the viewer may see (never missing, a placeholder or hidden from them). The view sets
        /// <see cref="JfEpisode.Playable"/> from the same "plays a file" fact its sources start from.
        /// </summary>
        public static bool Plays(JfEpisode episode) => !episode.Hidden && episode.Playable;

        /// <summary><see cref="Edition.Any"/> for a resolved movie or episode item (the viewer could resolve it, so they can open it).</summary>
        public static bool Plays(JfItemRef item) => item.Playable;

        /// <summary>
        /// The qualifying sources of one movie or episode item the viewer opens (a page's own item, an item an alert names):
        /// every version of it (dimensions read), each only where they can open the item that plays it. None for an item they
        /// can't open, a placeholder or a missing item.
        /// </summary>
        public IReadOnlyList<EditionHit> Item(StatusViewer viewer, Guid itemId, Edition edition)
            => _view.Sources(itemId, viewer).Where(s => Qualifies(s, edition))
                .Select(s => new EditionHit(itemId, s.ItemId, null, null, null, s)).ToList();

        /// <summary>
        /// What backs these movie or episode items, as Jellyfin holds it for anyone (the library context, whoever may open each
        /// version): the facts an arrival compares to tell a changed source (a new version, path or quality: an upgrade in
        /// place) from a version that only became visible to someone (D53, edition round 21). Movie items are read directly;
        /// episode items through the series copies they are in.
        /// </summary>
        /// <param name="items">Movie items, or episode items of <paramref name="seriesCopies"/>.</param>
        /// <param name="seriesCopies">For episode items: the series copies to read them in (null: movie items).</param>
        public IReadOnlyList<JfSource> HeldSources(IReadOnlyCollection<Guid> items, IReadOnlyList<JfCopy>? seriesCopies = null)
            => seriesCopies == null
                ? items.SelectMany(item => _view.Sources(item, StatusViewer.Library)).ToList()
                : seriesCopies.Select(c => c.ItemId).Distinct().SelectMany(series => _view.EpisodeSources(series, null, StatusViewer.Library))
                    .Where(e => items.Contains(e.ItemId)).SelectMany(e => e.Sources).ToList();

        /// <summary>
        /// The copies among <paramref name="copies"/> (movie items, or series items for a series) in which the viewer has a
        /// qualifying source: the copy readiness every Ready credit, variant line, arrival and "open in library" reads.
        /// </summary>
        public IReadOnlySet<Guid> Holding(StatusViewer viewer, IReadOnlyList<JfCopy> copies, bool movie, Edition edition, int? season = null)
            => (movie ? Movie(viewer, copies, edition, readDimensions: NeedsDimensions(edition)) : Episodes(viewer, copies, edition, season, readDimensions: NeedsDimensions(edition)).Hits)
                .Select(h => h.CopyId).ToHashSet();

        /// <summary>
        /// The qualifying sources of a movie across <paramref name="copies"/> the viewer can open, or only in the
        /// copy <paramref name="pinned"/> names (nothing when they can't open that one: never another copy).
        /// <paramref name="readDimensions"/> false reads each copy's own file only, without its versions' dimensions
        /// (only for a standard edition that takes any playable copy; a placeholder or missing item still has none).
        /// </summary>
        public IReadOnlyList<EditionHit> Movie(StatusViewer viewer, IReadOnlyList<JfCopy> copies, Edition edition, Guid? pinned = null, bool? readDimensions = null)
        {
            var hits = new List<EditionHit>();
            var dimensions = readDimensions ?? edition != Edition.Any;
            foreach (var copy in Openable(copies, pinned))
            {
                foreach (var source in _view.Sources(copy.ItemId, viewer, dimensions))
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
            => edition == Edition.Standard ? hits.OrderBy(h => IsFourK(h.Source.Width, h.Source.Height) || (h.Source.Width is null && h.Source.Height is null) ? 1 : 0).ToList() : hits;

        /// <summary>
        /// The qualifying episode sources of a series (one season, or all) across the series copies the viewer can
        /// open, each episode by its own sources in its own series item (so the folder automatic grouping lists
        /// with another never lends it an episode), or only in the series item <paramref name="pinned"/> names.
        /// <paramref name="readDimensions"/> false skips reading the sources' dimensions (only for a standard edition
        /// that takes any playable copy; with it, unread sources never qualify for 4K or a non-4K standard edition).
        /// </summary>
        public EpisodeEditions Episodes(StatusViewer viewer, IReadOnlyList<JfCopy> seriesCopies, Edition edition, int? season, Guid? pinned = null, bool? readDimensions = null)
        {
            var hits = new List<EditionHit>();
            var dimensions = readDimensions ?? edition != Edition.Any;
            foreach (var copy in Openable(seriesCopies, pinned))
            {
                foreach (var episode in _view.EpisodeSources(copy.ItemId, season, viewer, dimensions))
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

        /// <summary>
        /// How many episodes of a season have a qualifying source, by the episodes their files cover (a combined E1–E2 file is
        /// two; overlapping files count each episode once): the one count every episode total uses (D53, edition round 21).
        /// </summary>
        public long EpisodeCount(StatusViewer viewer, TitleKey series, int season, Edition edition, Guid? pinned = null)
            => series.IsMovie ? 0 : Episodes(viewer, _copies(series.Title, viewer), edition, season, pinned).CountInSeason(season);

        /// <summary>True when every episode of an episode range has a qualifying source (see <see cref="Scope"/>).</summary>
        public bool AvailableRange(StatusViewer viewer, TitleKey series, int season, int first, int last, Edition edition, Guid? pinned = null)
            => !series.IsMovie && Episodes(viewer, _copies(series.Title, viewer), edition, season, pinned).Covers(season, first, last);

        private static IEnumerable<JfCopy> Openable(IReadOnlyList<JfCopy> copies, Guid? pinned)
            => copies.Where(c => c.Visible && (pinned is not Guid id || c.ItemId == id)).GroupBy(c => c.ItemId).Select(g => g.First());
    }
}
