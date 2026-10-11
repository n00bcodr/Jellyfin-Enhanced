using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
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

        /// <summary>The Jellyfin user object (opaque outside <see cref="ArrJellyfinView"/>).</summary>
        internal object? Handle { get; init; }
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

        /// <summary>Every Jellyfin movie (or series) carrying the key's provider id, in any library.</summary>
        IReadOnlyList<JfCopy> Copies(TitleKey titleKey, StatusViewer viewer);

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
    }

    /// <summary>What a request system knows about a title (Seerr in Seerr mode; filled in by the read model).</summary>
    public sealed class RequestFacts
    {
        /// <summary>When it was asked for.</summary>
        public DateTime? AskedAt { get; init; }

        /// <summary>The viewer asked (false: someone else in the household).</summary>
        public bool AskedByViewer { get; init; }

        /// <summary>The request waits for an OK.</summary>
        public bool Pending { get; init; }

        /// <summary>When it was OK'd.</summary>
        public DateTime? ApprovedAt { get; init; }

        /// <summary>The request was declined.</summary>
        public bool Declined { get; init; }
    }

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
    }

    /// <summary>No request system: the composer works from the arrs and Jellyfin alone.</summary>
    public sealed class NoRequestFacts : IArrRequestFacts
    {
        /// <inheritdoc />
        public long Revision => 0;

        /// <inheritdoc />
        public RequestFacts? For(TitleKey titleKey, StatusViewer viewer) => null;
    }
}
