using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>
    /// Copy lookups (<see cref="IArrJellyfinView.Copies"/>) that reached their scan bound in the current flow: an
    /// HTTP read, a notification round, a recipe run. Such a lookup is <see cref="CopyLookupOutcome.Incomplete"/>: whatever
    /// is composed from it is never cached or stored (the next read scans again), and a background decision that would
    /// act on absence waits for a conclusive read. Work that keeps or acts on lookups starts a <see cref="Track"/> watch
    /// around them; the lookup calls <see cref="Note"/>.
    /// </summary>
    public static class CopyLookupBound
    {
        private static readonly AsyncLocal<Watch?> Current = new();

        /// <summary>True when a lookup reached its bound in the current flow since the innermost watch began.</summary>
        public static bool Reached => Current.Value?.Reached == true;

        /// <summary>Starts a watch for this flow (and the work it awaits); dispose it when the work is done.</summary>
        /// <returns>The watch.</returns>
        public static Watch Track()
        {
            var watch = new Watch(Current.Value);
            Current.Value = watch;
            return watch;
        }

        /// <summary>A lookup reached its bound: every watch of the flow sees it.</summary>
        internal static void Note()
        {
            for (var watch = Current.Value; watch != null; watch = watch.Parent) watch.Reached = true;
        }

        /// <summary>One watch over a piece of work.</summary>
        public sealed class Watch : IDisposable
        {
            private int _reached;

            internal Watch(Watch? parent) => Parent = parent;

            internal Watch? Parent { get; }

            /// <summary>True when a lookup of the work reached its bound.</summary>
            public bool Reached
            {
                get => Volatile.Read(ref _reached) == 1;
                internal set => Volatile.Write(ref _reached, value ? 1 : 0);
            }

            /// <summary>Ends the watch (the enclosing one, if any, is current again).</summary>
            public void Dispose()
            {
                if (ReferenceEquals(Current.Value, this)) Current.Value = Parent;
            }
        }
    }

    /// <summary>What a copy lookup established (<see cref="CopyLookup"/>).</summary>
    public enum CopyLookupOutcome
    {
        /// <summary>The scan finished and found at least one copy (one the viewer can open or not).</summary>
        Found,

        /// <summary>The scan finished and found none: the title is proven absent.</summary>
        ProvenAbsent,

        /// <summary>The scan reached its bound first: the copies it saw are facts, absence is not proven.</summary>
        Incomplete,
    }

    /// <summary>
    /// The answer of <see cref="IArrJellyfinView.Copies"/>: a value, never a list, so each reader states its policy.
    /// A page that only shows the title reads <see cref="Display"/> (an incomplete lookup shows as "not found", is
    /// never cached and never makes anything Ready or fulfilled). Anything that asserts absence (the absent-title
    /// rules, "since removed", "declined", a missing title offered or asked for, an alert's "can no longer open") acts
    /// only on <see cref="IsProvenAbsent"/>; on an incomplete lookup it fails closed. The copies the scan did see
    /// (<see cref="Seen"/>) are acted on either way: one the viewer can't open keeps the title hidden from them, one they
    /// can open counts as present.
    /// </summary>
    public sealed class CopyLookup
    {
        private CopyLookup(CopyLookupOutcome outcome, IReadOnlyList<JfCopy> seen)
        {
            Outcome = outcome;
            Seen = seen;
        }

        /// <summary>The finished scan that found nothing.</summary>
        public static CopyLookup Absent { get; } = new(CopyLookupOutcome.ProvenAbsent, Array.Empty<JfCopy>());

        /// <summary>A finished scan: found, or proven absent when it found nothing.</summary>
        /// <param name="copies">Every copy it found.</param>
        /// <returns>The lookup.</returns>
        public static CopyLookup Complete(IReadOnlyList<JfCopy> copies) => copies.Count == 0 ? Absent : new(CopyLookupOutcome.Found, copies);

        /// <summary>A scan that reached its bound.</summary>
        /// <param name="seen">The copies it saw before (in the order a finished scan lists them first).</param>
        /// <returns>The lookup.</returns>
        public static CopyLookup Incomplete(IReadOnlyList<JfCopy> seen) => new(CopyLookupOutcome.Incomplete, seen);

        /// <summary>What the scan established.</summary>
        public CopyLookupOutcome Outcome { get; }

        /// <summary>The scan finished (found, or proven absent).</summary>
        public bool IsComplete => Outcome != CopyLookupOutcome.Incomplete;

        /// <summary>The scan finished and found no copy: the only answer the absent-title rules accept.</summary>
        public bool IsProvenAbsent => Outcome == CopyLookupOutcome.ProvenAbsent;

        /// <summary>The copies the scan saw: every copy when it finished, the first ones otherwise.</summary>
        public IReadOnlyList<JfCopy> Seen { get; }

        /// <summary>A copy the viewer can open that the scan saw (present, finished or not), or null.</summary>
        public JfCopy? SeenOpenable => Seen.FirstOrDefault(c => c.Visible);

        /// <summary>The copies a page shows: every copy of a finished scan; none of an incomplete one ("not found").</summary>
        public IReadOnlyList<JfCopy> Display => IsComplete ? Seen : Array.Empty<JfCopy>();
    }

    /// <summary>
    /// Who is asking for a status: the Jellyfin user and everything about them that changes what
    /// they may see (role, library access, parental limits, "show missing episodes"), condensed
    /// into <see cref="PolicyRevision"/> for the per-user status cache.
    /// </summary>
    public sealed class StatusViewer
    {
        /// <summary>Jellyfin user id.</summary>
        public Guid UserId { get; init; }

        /// <summary>Jellyfin administrator (gets the admin shape).</summary>
        public bool IsAdmin { get; init; }

        /// <summary>The user shows missing (virtual) episodes on season pages.</summary>
        public bool DisplayMissingEpisodes { get; init; }

        /// <summary>The user has a parental rating limit, blocked/allowed tags or blocked unrated items (not library access).</summary>
        public bool HasParentalLimit { get; init; }

        /// <summary>Fingerprint of role, library access, parental settings and display options.</summary>
        public string PolicyRevision { get; init; } = string.Empty;

        /// <summary>The Jellyfin user object, used only for server-side item and destination access checks.</summary>
        internal object? Handle { get; init; }

        /// <summary>
        /// The server's library context (no person): <see cref="IArrJellyfinView.Copies"/>, <see cref="IArrJellyfinView.Sources"/>
        /// and <see cref="IArrJellyfinView.EpisodeSources"/> answer for every item, with no access filter (a list's server
        /// context, a background job). Every other view method answers nothing for it.
        /// </summary>
        public bool IsLibraryContext { get; init; }

        /// <summary>The server's library context (see <see cref="IsLibraryContext"/>).</summary>
        public static StatusViewer Library { get; } = new() { IsLibraryContext = true, IsAdmin = true, PolicyRevision = "library" };
    }

    /// <summary>A Jellyfin item a status was asked for, resolved for one viewer (only items the viewer can see).</summary>
    public sealed class JfItemRef
    {
        /// <summary>Item id.</summary>
        public Guid ItemId { get; init; }

        /// <summary>movie, series, season or episode.</summary>
        public string Kind { get; init; } = string.Empty;

        /// <summary>Title key (season/episode keys carry their numbers); null when the item has no usable provider id.</summary>
        public TitleKey? Key { get; init; }

        /// <summary>The series item (seasons and episodes).</summary>
        public Guid? SeriesId { get; init; }

        /// <summary>Season number (seasons and episodes).</summary>
        public int? Season { get; init; }

        /// <summary>Episode number (episodes).</summary>
        public int? Episode { get; init; }

        /// <summary>Last episode number of a multi-episode file.</summary>
        public int? EpisodeEnd { get; init; }

        /// <summary>A virtual (missing) episode or season: no file.</summary>
        public bool Virtual { get; init; }

        /// <summary>File or folder path (server-side matching only; never sent).</summary>
        public string? Path { get; init; }

        /// <summary>When Jellyfin added the item (UTC).</summary>
        public DateTime? DateCreated { get; init; }

        /// <summary>Library (collection folder) id of a movie (matches the item to an arr copy by linked library).</summary>
        public string? LibraryId { get; init; }

        /// <summary>Library name of a movie.</summary>
        public string? LibraryName { get; init; }

        /// <summary>TMDB id of the movie, or of the series a season or episode belongs to (metadata lookups only).</summary>
        public int? TmdbId { get; init; }

        /// <summary>
        /// How many versions (media sources) Jellyfin plays a movie or episode from: 1 for one file, more when it
        /// keeps several files as one item (its version picker); 0 when unknown or not a movie or episode.
        /// </summary>
        public int Versions { get; init; }

        /// <summary>
        /// The movie or episode Jellyfin now keeps this one's file under as one of its versions (another item: it
        /// makes the highest resolution the item and the other files its versions), or null.
        /// </summary>
        public Guid? PrimaryId { get; init; }
    }

    /// <summary>One Jellyfin copy of a movie or series (any library), with whether the viewer can open it.</summary>
    public sealed class JfCopy
    {
        /// <summary>Item id.</summary>
        public Guid ItemId { get; init; }

        /// <summary>The viewer can open it (library access and parental limits).</summary>
        public bool Visible { get; init; }

        /// <summary>Library (collection folder) id.</summary>
        public string? LibraryId { get; init; }

        /// <summary>Library name.</summary>
        public string? LibraryName { get; init; }

        /// <summary>File or folder path (server-side matching only).</summary>
        public string? Path { get; init; }

        /// <summary>When Jellyfin added it (UTC).</summary>
        public DateTime? DateCreated { get; init; }
    }

    /// <summary>
    /// One playable media source of a movie or episode (one of its versions), as Jellyfin plays it: its own id,
    /// file and video dimensions. Never sent to the browser (the path is server-side only).
    /// </summary>
    public sealed class JfSource
    {
        /// <summary>Jellyfin's media source id (not a permanent identity: 10.11 changes it while grouping versions).</summary>
        public Guid SourceId { get; init; }

        /// <summary>The movie or episode the viewer opens to play it (the item Jellyfin lists it under: the primary).</summary>
        public Guid ItemId { get; init; }

        /// <summary>
        /// The exact item that is this version (the primary for its own file, else the alternate's own item, found by
        /// source id or path): what a playlist or collection inserts to play exactly this file. A source with no such
        /// item is never listed.
        /// </summary>
        public Guid BackingItemId { get; init; }

        /// <summary>Width of its video stream; null while Jellyfin hasn't read the file yet.</summary>
        public int? Width { get; init; }

        /// <summary>Height of its video stream; null while Jellyfin hasn't read the file yet.</summary>
        public int? Height { get; init; }

        /// <summary>The file (server-side matching only).</summary>
        public string? Path { get; init; }

        /// <summary>When Jellyfin added this version (UTC).</summary>
        public DateTime? DateCreated { get; init; }
    }

    /// <summary>One episode item of exactly one series item (never another grouped folder's), with its playable sources.</summary>
    public sealed class JfEpisodeSources
    {
        /// <summary>Episode item id.</summary>
        public Guid ItemId { get; init; }

        /// <summary>Season number.</summary>
        public int Season { get; init; }

        /// <summary>Episode number.</summary>
        public int Episode { get; init; }

        /// <summary>Last episode number of a multi-episode file.</summary>
        public int? EpisodeEnd { get; init; }

        /// <summary>Its playable sources (12.x keeps an episode's other files as versions of one item; 10.11 lists them as more items).</summary>
        public IReadOnlyList<JfSource> Sources { get; init; } = Array.Empty<JfSource>();
    }

    /// <summary>One Jellyfin episode of a series, as the viewer sees it.</summary>
    public sealed class JfEpisode
    {
        /// <summary>Item id.</summary>
        public Guid ItemId { get; init; }

        /// <summary>Season number.</summary>
        public int Season { get; init; }

        /// <summary>Episode number.</summary>
        public int Episode { get; init; }

        /// <summary>Last episode number of a multi-episode file.</summary>
        public int? EpisodeEnd { get; init; }

        /// <summary>Virtual (missing) episode.</summary>
        public bool Virtual { get; init; }

        /// <summary>When Jellyfin added it (UTC).</summary>
        public DateTime? DateCreated { get; init; }

        /// <summary>
        /// A Jellyfin episode (real, or virtual when <see cref="Virtual"/>) this viewer may not see
        /// (its own rating, tags or a hidden season): only its numbers are given (no item id) so the
        /// composer can leave it out instead of reading it as "not in the library".
        /// </summary>
        public bool Hidden { get; init; }
    }

    /// <summary>One Jellyfin season of a series, as the viewer sees it.</summary>
    public sealed class JfSeason
    {
        /// <summary>Item id.</summary>
        public Guid ItemId { get; init; }

        /// <summary>Season number.</summary>
        public int Season { get; init; }

        /// <summary>
        /// A season Jellyfin has but hides from this viewer (its own rating or tags): only its number
        /// is given (no item id), so the composer leaves the season out instead of filling it from Sonarr.
        /// </summary>
        public bool Hidden { get; init; }
    }

    /// <summary>
    /// The Jellyfin side of the status composer: resolves items for a viewer (only what they may
    /// see), finds every copy of a title across libraries, lists episodes the way the season page
    /// shows them (virtual episodes only for viewers who show missing episodes), and reports a
    /// revision that changes whenever library items are added, changed or removed.
    /// </summary>
    public interface IArrJellyfinView
    {
        /// <summary>Changes whenever a movie, series, season or episode is added, updated or removed.</summary>
        long Revision { get; }

        /// <summary>The viewer for a user id, or null for an unknown user.</summary>
        StatusViewer? Viewer(Guid userId);

        /// <summary>The item if the viewer can see it and it is a movie, series, season or episode; otherwise null.</summary>
        JfItemRef? Resolve(Guid itemId, StatusViewer viewer);

        /// <summary>
        /// Every Jellyfin movie (or series) carrying the key's provider id, or any of its
        /// <paramref name="aliases"/> (the title's other ids, <see cref="TitleAliases"/>), in any
        /// current library: the key's kind only, once per item, up to twenty eligible copies. Native
        /// query limits apply after current-library membership, with bounded paging. A scan that reaches its
        /// bound is <see cref="CopyLookupOutcome.Incomplete"/> with the copies it saw, and tells <see cref="CopyLookupBound"/>.
        /// </summary>
        CopyLookup Copies(TitleKey titleKey, StatusViewer viewer, IReadOnlyCollection<TitleKey>? aliases = null);

        /// <summary>
        /// The series' episodes the viewer can see (one season, or all when null), virtual ones included
        /// when asked; for a viewer with parental limits also the episodes (real or virtual) Jellyfin
        /// hides from them, marked <see cref="JfEpisode.Hidden"/> (numbers only).
        /// </summary>
        IReadOnlyList<JfEpisode> Episodes(Guid seriesItemId, int? season, StatusViewer viewer, bool includeVirtual);

        /// <summary>
        /// The series' seasons the viewer can see; for a viewer with parental limits also the seasons
        /// Jellyfin hides from them, marked <see cref="JfSeason.Hidden"/> (numbers only).
        /// </summary>
        IReadOnlyList<JfSeason> Seasons(Guid seriesItemId, StatusViewer viewer);

        /// <summary>
        /// The ids of exactly this series item's season <paramref name="season"/> (<paramref name="episode"/> null),
        /// or of its episodes of that season covering <paramref name="episode"/> (a multi-episode file included),
        /// missing (virtual) ones included: only items whose own series is this one, never another series item
        /// Jellyfin's automatic series grouping lists with it (<see cref="Episodes"/> and <see cref="Seasons"/>
        /// follow Jellyfin's grouped lists), and never a second version of an episode (its primary item stands
        /// for every version). Empty when the viewer can't open the series. Not filtered further for the viewer:
        /// resolve each id as them.
        /// </summary>
        IReadOnlyList<Guid> SeriesParts(Guid seriesItemId, int season, int? episode, StatusViewer viewer);

        /// <summary>
        /// Of <paramref name="candidates"/> (movies or episodes), the one the viewer can open that keeps the file of
        /// <paramref name="itemId"/> as one of its versions: Jellyfin deletes a movie item whose file becomes a
        /// version of a new item on 10.11 (12.x keeps it as that item's version, see <see cref="JfItemRef.PrimaryId"/>).
        /// Null when none does.
        /// </summary>
        Guid? VersionHolder(Guid itemId, IReadOnlyList<Guid> candidates, StatusViewer viewer);

        /// <summary>
        /// The playable sources (versions) of a movie or episode the viewer can open, each with its own video
        /// dimensions (Jellyfin's media sources). Empty for a missing (virtual) item, a placeholder, another kind
        /// of item, or one the viewer can't open. A version counts only when the viewer can open the item that plays
        /// it too (Jellyfin's own check: a version in a library they can't open, or one its parental rules hide from
        /// them, is not theirs). Without <paramref name="readDimensions"/> the item has one source with no dimensions
        /// (its media sources aren't read: enough when any playable copy will do).
        /// </summary>
        IReadOnlyList<JfSource> Sources(Guid itemId, StatusViewer viewer, bool readDimensions = true);

        /// <summary>
        /// The episodes with a file of exactly this series item (its own folders, never another series item
        /// Jellyfin's automatic grouping lists with it, never a second version of an episode as an item of its
        /// own), of one season or all, that the viewer can open, each with its playable sources. Empty when the
        /// viewer can't open the series. Without <paramref name="readDimensions"/> each episode has one source with no
        /// dimensions (Jellyfin's media sources aren't read: enough when any playable copy will do).
        /// </summary>
        IReadOnlyList<JfEpisodeSources> EpisodeSources(Guid seriesItemId, int? season, StatusViewer viewer, bool readDimensions = true);

        /// <summary>
        /// The other series items Jellyfin's automatic series grouping presents as one show with this one (the
        /// same presentation key: the same provider id, language and library) that the viewer can open.
        /// </summary>
        IReadOnlyList<Guid> GroupedSeries(Guid seriesItemId, StatusViewer viewer);
    }

    /// <summary>What a request system knows about a title (Seerr in Seerr mode; filled in by the read model).</summary>
    public sealed class RequestFacts
    {
        /// <summary>When it was asked for.</summary>
        public DateTime? AskedAt { get; init; }

        /// <summary>The viewer asked (false: someone else in the household).</summary>
        public bool AskedByViewer { get; init; }

        /// <summary>
        /// The whole seasons the viewer asked for themselves (the standard copy; requests still on, JE request ledger),
        /// so a series page doesn't offer them again once Sonarr has them and the status no longer says "asked".
        /// </summary>
        public IReadOnlyList<int> ViewerSeasons { get; init; } = Array.Empty<int>();

        /// <summary>The request waits for an OK.</summary>
        public bool Pending { get; init; }

        /// <summary>
        /// Why a pending request was held back at sending (for example <c>invalid_defaults</c>), when none of the
        /// pending requests simply waits for an OK; null otherwise. Only administrators are told (it is theirs to fix).
        /// </summary>
        public string? HeldReason { get; init; }

        /// <summary>When it was OK'd.</summary>
        public DateTime? ApprovedAt { get; init; }

        /// <summary>When a standard-quality request for it was OK'd (null: none; both null with <see cref="ApprovedAt"/> set: variant unknown).</summary>
        public DateTime? ApprovedStandardAt { get; init; }

        /// <summary>When a 4K request for it was OK'd (null: none).</summary>
        public DateTime? Approved4kAt { get; init; }

        /// <summary>
        /// Seerr says the standard-quality variant is done: a request for it is completed, or its media
        /// is (partly) available. A done variant is never "OK'd, but no Sonarr/Radarr has it".
        /// </summary>
        public bool StandardDone { get; init; }

        /// <summary>Seerr says the 4K variant is done (see <see cref="StandardDone"/>).</summary>
        public bool FourKDone { get; init; }

        /// <summary>
        /// Every request still on for it arrived (JE request ledger: all fulfilled, nothing waiting or on its way).
        /// Such a request never reads "OK'd! Getting started" again: once the title left Jellyfin and the arrs it
        /// reads "Was here, since removed".
        /// </summary>
        public bool Fulfilled { get; init; }

        /// <summary>The request was declined.</summary>
        public bool Declined { get; init; }

        /// <summary>
        /// Every OK'd request waits because Sonarr doesn't list the season or episode asked for yet (JE request ledger: queued,
        /// reason <c>not_aired</c>; it is checked again on its own). It reads "Not aired yet", not "OK'd! Getting started".
        /// </summary>
        public bool NotListed { get; init; }

        /// <summary>
        /// Every OK'd request is held after its OK for something a person has to sort out (no 4K instance can take it
        /// now, no Seerr account, the connection changed, …): it reads "Taking longer than usual", not "OK'd! Getting
        /// started" (the Approvals card says why).
        /// </summary>
        public bool HeldAfterOk { get; init; }

        /// <summary>
        /// The parts of the title that requests on their way cover (sent to Sonarr/Radarr by Jellyfin
        /// Enhanced, or OK'd in Seerr), each with when that happened. "Nothing grabbed for a long while"
        /// counts from then: an episode asked for today in a series the arr has listed for years is
        /// still fresh.
        /// </summary>
        public IReadOnlyList<RequestSentPart> Sent { get; init; } = Array.Empty<RequestSentPart>();

        /// <summary>
        /// The latest time a request covering this part went out, for the standard or the 4K copy;
        /// null when none did. <paramref name="season"/> null asks about the whole title (any part
        /// counts); <paramref name="episode"/> null about a whole season (any of its parts counts).
        /// </summary>
        /// <param name="fourK">The 4K copy (else the standard one).</param>
        /// <param name="season">Season number, or null for the title.</param>
        /// <param name="episode">Episode number, or null for the season.</param>
        /// <returns>When, or null.</returns>
        public DateTime? SentFor(bool fourK, int? season, int? episode)
        {
            DateTime? latest = null;
            foreach (var part in Sent)
            {
                if (part.FourK != fourK) continue;
                var covers = season == null || part.Season == null
                    || (part.Season == season && (episode == null || part.Episode == null || part.Episode == episode));
                if (covers && (latest == null || part.At > latest)) latest = part.At;
            }

            return latest;
        }
    }

    /// <summary>
    /// One part of a title a request on its way covers (see <see cref="RequestFacts.Sent"/>):
    /// <paramref name="Season"/> null is the whole title, <paramref name="Episode"/> null a whole season.
    /// </summary>
    /// <param name="FourK">For the 4K copy.</param>
    /// <param name="Season">Season number, or null for the whole title.</param>
    /// <param name="Episode">Episode number, or null for the whole season.</param>
    /// <param name="At">When the request went out (UTC).</param>
    public sealed record RequestSentPart(bool FourK, int? Season, int? Episode, DateTime At);

    /// <summary>
    /// Source of request facts for the status composer. The default knows nothing; the Seerr read
    /// model replaces it in Seerr mode. <see cref="Revision"/> must change whenever any answer may have.
    /// </summary>
    public interface IArrRequestFacts
    {
        /// <summary>Changes whenever any answer may have changed.</summary>
        long Revision { get; }

        /// <summary>What is known about requests for a title (movie or series key), as seen by the viewer; null when nothing.</summary>
        RequestFacts? For(TitleKey titleKey, StatusViewer viewer);

        /// <summary>
        /// What is known about the requests that cover one episode of a series (asks for the episode or a
        /// season that holds it, never the series' other parts), as seen by the viewer; null when nothing
        /// or when this source can't tell parts apart.
        /// </summary>
        /// <param name="seriesKey">Series key.</param>
        /// <param name="season">Season number.</param>
        /// <param name="episode">Episode number.</param>
        /// <param name="viewer">Viewer.</param>
        /// <returns>Request facts, or null.</returns>
        RequestFacts? ForEpisode(TitleKey seriesKey, int season, int episode, StatusViewer viewer) => null;

        /// <summary>
        /// What is known about the requests that cover a whole season of a series (asks for that season,
        /// or for the whole series where the source asks that way; never asks for single episodes or
        /// other seasons), as seen by the viewer; null when nothing or when this source can't tell parts apart.
        /// </summary>
        /// <param name="seriesKey">Series key.</param>
        /// <param name="season">Season number.</param>
        /// <param name="viewer">Viewer.</param>
        /// <returns>Request facts, or null.</returns>
        RequestFacts? ForSeason(TitleKey seriesKey, int season, StatusViewer viewer) => null;

        /// <summary>
        /// True when this user asked for the title (movie or series key) themselves. Such a title is
        /// theirs to follow even before it is in Jellyfin, whatever their content limits.
        /// </summary>
        bool AskedBy(TitleKey titleKey, Guid userId);

        /// <summary>True when anyone has a request for the title (movie or series key), declined ones included.</summary>
        bool Requested(TitleKey titleKey);

        /// <summary>
        /// <see cref="AskedBy"/>, or true for a few minutes after the user's last request for the
        /// title went away (the change feed's audience: the announcement of a deleted request is
        /// read after the list no longer has it, and the requester must still hear about it).
        /// </summary>
        bool AskedLatelyBy(TitleKey titleKey, Guid userId);

        /// <summary><see cref="Requested"/>, or true for a few minutes after the title's last request went away (the change feed's audience).</summary>
        bool RequestedLately(TitleKey titleKey);
    }

    /// <summary>No request system: the composer works from the arrs and Jellyfin alone.</summary>
    public sealed class NoRequestFacts : IArrRequestFacts
    {
        /// <inheritdoc />
        public long Revision => 0;

        /// <inheritdoc />
        public RequestFacts? For(TitleKey titleKey, StatusViewer viewer) => null;

        /// <inheritdoc />
        public bool AskedBy(TitleKey titleKey, Guid userId) => false;

        /// <inheritdoc />
        public bool Requested(TitleKey titleKey) => false;

        /// <inheritdoc />
        public bool AskedLatelyBy(TitleKey titleKey, Guid userId) => false;

        /// <inheritdoc />
        public bool RequestedLately(TitleKey titleKey) => false;
    }
}
