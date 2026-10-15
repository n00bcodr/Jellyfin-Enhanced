#if JF12
using System;
using System.Collections.Concurrent;
using System.Globalization;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>
    /// Where the names on a synthetic page lead for one viewer: cast and crew, genres, studios and
    /// networks, tags. A name leads to the library's own page when Jellyfin has it and the viewer would
    /// find something there, else to a destination made from public data (a person page, or the
    /// discovery page of a genre, studio or network), else nowhere (left off the page).
    /// </summary>
    public interface ITitleLinks
    {
        /// <summary>The library person with this TMDB id the viewer can open, with its primary image tag; null when there is none.</summary>
        /// <param name="name">Name (Jellyfin keys people by name).</param>
        /// <param name="tmdb">TMDB person id (must match the library person's).</param>
        /// <returns>Person id and image tag, or null.</returns>
        (Guid Id, string? ImageTag)? Person(string name, int tmdb);

        /// <summary>The id a genre links to (the library genre or the genre's discovery page), or null.</summary>
        /// <param name="name">Genre name.</param>
        /// <param name="tmdb">TMDB genre id.</param>
        /// <returns>Id or null.</returns>
        Guid? Genre(string name, int tmdb);

        /// <summary>The id a studio or network links to (the library studio or its discovery page), or null.</summary>
        /// <param name="name">Studio or network name.</param>
        /// <param name="tmdb">TMDB company or network id.</param>
        /// <param name="network">True for a TV network (else a production company).</param>
        /// <returns>Id or null.</returns>
        Guid? Studio(string name, int tmdb, bool network);

        /// <summary>True when a tag (TMDB keyword) leads somewhere: the viewer's tagged library items or the tag's discovery row.</summary>
        /// <param name="name">Tag name.</param>
        /// <returns>True when it is kept on the page.</returns>
        bool Tag(string name);
    }

    /// <summary>Which discovery destinations a viewer gets (JE's genre, network and tag discovery rows, which need Seerr).</summary>
    /// <param name="Genres">Genre discovery rows render for the viewer.</param>
    /// <param name="Studios">Studio/network discovery rows render for the viewer.</param>
    /// <param name="Tags">Tag discovery rows render for the viewer.</param>
    public readonly record struct LinkDiscovery(bool Genres, bool Studios, bool Tags)
    {
        /// <summary>No discovery destination (links only to the library's own pages).</summary>
        public static LinkDiscovery None => default;
    }

    /// <summary>
    /// Resolves <see cref="ITitleLinks"/> from the library (read only: never creates a person, genre or
    /// studio). Library existence is cached per library revision; what a viewer may open (a person's
    /// page, the titles behind a genre, studio or tag) per viewer policy revision and library revision,
    /// each for a short while.
    /// </summary>
    public sealed class NativeDetailsLinks
    {
        private const int MaxEntries = 4000;
        private static readonly TimeSpan Ttl = TimeSpan.FromSeconds(30);
        private static readonly BaseItemKind[] Titles = { BaseItemKind.Movie, BaseItemKind.Series };

        private readonly ILibraryManager _library;
        private readonly IImageProcessor? _images;
        private readonly Func<long>? _revision;
        private readonly ConcurrentDictionary<string, (long Revision, DateTime At, Guid? Id, string? Tag)> _people = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, (long Revision, DateTime At, bool Found)> _visible = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, (long Revision, DateTime At, Guid? Id)> _names = new(StringComparer.Ordinal);

        /// <summary>Creates the resolver.</summary>
        /// <param name="library">Library manager.</param>
        /// <param name="images">Image processor (library people's image tags), or null for none.</param>
        /// <param name="revision">Library revision (changes on every add/update/remove); without it nothing is cached.</param>
        public NativeDetailsLinks(ILibraryManager library, IImageProcessor? images = null, Func<long>? revision = null)
        {
            _library = library;
            _images = images;
            _revision = revision;
        }

        /// <summary>The links of one viewer.</summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="viewerRevision">The viewer's policy revision (part of the cache key).</param>
        /// <param name="serverId">This server's id (for discovery-page ids).</param>
        /// <param name="discovery">The discovery destinations the viewer gets.</param>
        /// <returns>The links.</returns>
        public ITitleLinks For(User viewer, string viewerRevision, string serverId, LinkDiscovery discovery)
            => new ViewerLinks(this, viewer, viewerRevision, serverId, discovery);

        /// <summary>The library person with this TMDB id (any viewer), with its image tag; cached per library revision.</summary>
        private (Guid? Id, string? Tag) LibraryPerson(string name, int tmdb)
        {
            var key = tmdb.ToString(CultureInfo.InvariantCulture) + "|" + name;
            var revision = _revision?.Invoke();
            if (revision is long r && _people.TryGetValue(key, out var hit) && hit.Revision == r && DateTime.UtcNow - hit.At < Ttl * 10) return (hit.Id, hit.Tag);
            Guid? id = null;
            string? tag = null;
            try
            {
                // Jellyfin keys people by name; the TMDB id tells a namesake apart (no id: not the same person).
                if (_library.GetPerson(name) is { } person
                    && string.Equals(person.GetProviderId(MetadataProvider.Tmdb), tmdb.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal))
                {
                    id = person.Id;
                    if (_images != null && person.GetImageInfo(ImageType.Primary, 0) is { } image) tag = _images.GetImageCacheTag(person, image);
                }
            }
            catch (Exception)
            {
                // Not resolvable now: the person's own page.
                id = null;
                tag = null;
            }

            if (revision is long now)
            {
                if (_people.Count >= MaxEntries) _people.Clear();
                _people[key] = (now, DateTime.UtcNow, id, tag);
            }

            return (id, tag);
        }

        /// <summary>True when the viewer finds at least one movie or series behind a library genre, studio or tag.</summary>
        private bool Finds(User viewer, string viewerRevision, string kind, string name, Func<InternalItemsQuery, InternalItemsQuery> filter)
        {
            var key = string.Join('|', viewer.Id.ToString("N", CultureInfo.InvariantCulture), viewerRevision, kind, name);
            var revision = _revision?.Invoke();
            if (revision is long r && _visible.TryGetValue(key, out var hit) && hit.Revision == r && DateTime.UtcNow - hit.At < Ttl) return hit.Found;
            bool found;
            try
            {
                // The viewer's own query: their libraries and parental rules, as the list page would apply them.
                var items = _library.GetItemList(filter(new InternalItemsQuery(viewer)
                {
                    IncludeItemTypes = Titles,
                    Recursive = true,
                    Limit = 1,
                    DtoOptions = new DtoOptions(false),
                }));
                found = items != null && items.Count > 0;
            }
            catch (Exception)
            {
                found = false;
            }

            if (revision is long now)
            {
                if (_visible.Count >= MaxEntries) _visible.Clear();
                _visible[key] = (now, DateTime.UtcNow, found);
            }

            return found;
        }

        /// <summary>True when Jellyfin lets the viewer open this library item (cached like <see cref="Finds"/>).</summary>
        private bool Opens(User viewer, string viewerRevision, Guid id)
        {
            var key = string.Join('|', viewer.Id.ToString("N", CultureInfo.InvariantCulture), viewerRevision, "open", id.ToString("N", CultureInfo.InvariantCulture));
            var revision = _revision?.Invoke();
            if (revision is long r && _visible.TryGetValue(key, out var hit) && hit.Revision == r && DateTime.UtcNow - hit.At < Ttl) return hit.Found;
            bool opens;
            try
            {
                opens = _library.GetItemById<BaseItem>(id, viewer) != null;
            }
            catch (Exception)
            {
                opens = false;
            }

            if (revision is long now)
            {
                if (_visible.Count >= MaxEntries) _visible.Clear();
                _visible[key] = (now, DateTime.UtcNow, opens);
            }

            return opens;
        }

        /// <summary>The library's genre or studio of this name (never created), or null; cached per library revision.</summary>
        private Guid? LibraryName(string name, bool genre)
        {
            var key = (genre ? "g|" : "s|") + name;
            var revision = _revision?.Invoke();
            if (revision is long r && _names.TryGetValue(key, out var hit) && hit.Revision == r && DateTime.UtcNow - hit.At < Ttl * 10) return hit.Id;
            Guid? found;
            try
            {
                var id = genre ? _library.GetGenreId(name) : _library.GetStudioId(name);
                var item = _library.GetItemById(id);
                found = genre ? (item is Genre ? id : null) : (item is Studio ? id : null);
            }
            catch (Exception)
            {
                found = null;
            }

            if (revision is long now)
            {
                if (_names.Count >= MaxEntries) _names.Clear();
                _names[key] = (now, DateTime.UtcNow, found);
            }

            return found;
        }

        private sealed class ViewerLinks : ITitleLinks
        {
            private readonly NativeDetailsLinks _owner;
            private readonly User _viewer;
            private readonly string _revision;
            private readonly string _serverId;
            private readonly LinkDiscovery _discovery;

            public ViewerLinks(NativeDetailsLinks owner, User viewer, string revision, string serverId, LinkDiscovery discovery)
            {
                _owner = owner;
                _viewer = viewer;
                _revision = revision;
                _serverId = serverId;
                _discovery = discovery;
            }

            public (Guid Id, string? ImageTag)? Person(string name, int tmdb)
            {
                if (string.IsNullOrWhiteSpace(name) || tmdb <= 0) return null;
                var (id, tag) = _owner.LibraryPerson(name, tmdb);
                if (id is not { } found) return null;
                // Jellyfin's own check for the viewer (the person page native would open).
                return _owner.Opens(_viewer, _revision, found) ? (found, tag) : null;
            }

            public Guid? Genre(string name, int tmdb)
            {
                if (string.IsNullOrWhiteSpace(name)) return null;
                if (_owner.LibraryName(name, genre: true) is { } id
                    && _owner.Finds(_viewer, _revision, "genre", name, q => { q.GenreIds = new[] { id }; return q; }))
                {
                    return id;
                }

                return _discovery.Genres && tmdb > 0 ? SyntheticId.Genre(tmdb).ToGuid(_serverId) : null;
            }

            public Guid? Studio(string name, int tmdb, bool network)
            {
                if (string.IsNullOrWhiteSpace(name)) return null;
                if (_owner.LibraryName(name, genre: false) is { } id
                    && _owner.Finds(_viewer, _revision, "studio", name, q => { q.StudioIds = new[] { id }; return q; }))
                {
                    return id;
                }

                if (!_discovery.Studios || tmdb <= 0) return null;
                return (network ? SyntheticId.Network(tmdb) : SyntheticId.Studio(tmdb)).ToGuid(_serverId);
            }

            public bool Tag(string name)
            {
                if (string.IsNullOrWhiteSpace(name)) return false;
                // The tag page shows the viewer's tagged items and, with tag discovery, the tag's row.
                return _discovery.Tags || _owner.Finds(_viewer, _revision, "tag", name, q => { q.Tags = new[] { name }; return q; });
            }
        }
    }
}
#endif
