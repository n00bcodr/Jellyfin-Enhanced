#if JF12
using System;
using System.Collections.Concurrent;
using System.Globalization;
using System.Linq;
using System.Threading;
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
    /// studio). Every answer is kept under the library's state as it was before it was read: the library revision,
    /// every library item added, updated or removed (any kind: titles, people, genres, studios, folders), and, for what a
    /// viewer may open (a person's page, the titles behind a genre, studio or tag), the library topology and the viewer's
    /// policy revision (their full authority as just read). Any of those moving answers it again, positive or negative,
    /// at once; <see cref="Ttl"/> bounds only what none of them sees (a write straight into Jellyfin's database).
    /// </summary>
    public sealed class NativeDetailsLinks : IDisposable
    {
        private const int MaxEntries = 4000;

        /// <summary>The longest an answer is kept when nothing it depends on is seen to change.</summary>
        internal static readonly TimeSpan Ttl = TimeSpan.FromMinutes(5);
        private static readonly BaseItemKind[] Titles = { BaseItemKind.Movie, BaseItemKind.Series };

        private readonly ILibraryManager _library;
        private readonly IImageProcessor? _images;
        private readonly Func<long>? _revision;
        private readonly ConcurrentDictionary<string, (State State, Guid? Id, string? Tag)> _people = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, (State State, string Topology, bool Found)> _visible = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, (State State, Guid? Id)> _names = new(StringComparer.Ordinal);
        private long _changes;

        /// <summary>Creates the resolver and starts following library item changes.</summary>
        /// <param name="library">Library manager.</param>
        /// <param name="images">Image processor (library people's image tags), or null for none.</param>
        /// <param name="revision">Library revision (the arr view's); without it nothing is cached.</param>
        public NativeDetailsLinks(ILibraryManager library, IImageProcessor? images = null, Func<long>? revision = null)
        {
            _library = library;
            _images = images;
            _revision = revision;
            _library.ItemAdded += OnItemChanged;
            _library.ItemUpdated += OnItemChanged;
            _library.ItemRemoved += OnItemChanged;
        }

        /// <summary>The clock answers are aged by (tests move it).</summary>
        internal Func<DateTime> Clock { get; set; } = () => DateTime.UtcNow;

        /// <summary>Viewer answers held (valid or not yet dropped).</summary>
        internal int VisibleCount => _visible.Count;

        /// <summary>The links of one viewer.</summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="viewerRevision">The viewer's policy revision (part of the cache key).</param>
        /// <param name="serverId">This server's id (for discovery-page ids).</param>
        /// <param name="discovery">The discovery destinations the viewer gets.</param>
        /// <returns>The links.</returns>
        public ITitleLinks For(User viewer, string viewerRevision, string serverId, LinkDiscovery discovery)
            => new ViewerLinks(this, viewer, viewerRevision, serverId, discovery);

        /// <summary>Stops following library changes.</summary>
        public void Dispose()
        {
            _library.ItemAdded -= OnItemChanged;
            _library.ItemUpdated -= OnItemChanged;
            _library.ItemRemoved -= OnItemChanged;
        }

        private void OnItemChanged(object? sender, ItemChangeEventArgs e) => Interlocked.Increment(ref _changes);

        /// <summary>
        /// The library's state now, taken BEFORE reading what is kept under it: an answer read across a change carries the
        /// state from before it, so it is never served once the change is seen. Null when nothing may be cached.
        /// </summary>
        private State? Now() => _revision?.Invoke() is long revision ? new State(revision, Interlocked.Read(ref _changes), Clock()) : null;

        private bool Fresh(State held, State? now) => now is { } n && held.Revision == n.Revision && held.Changes == n.Changes && n.At - held.At < Ttl;

        /// <summary>The library's change marks (its revision, when there is one, and every item event seen).</summary>
        private (long? Revision, long Changes) Marks() => (_revision?.Invoke(), Interlocked.Read(ref _changes));

        /// <summary>
        /// Reads <paramref name="read"/> and lets its answer out only when nothing it depends on moved while it ran: the
        /// library's change marks and, for a viewer's answer (<paramref name="page"/>), the library topology, both compared
        /// before and after. A read that crossed a change is read again (at most <see cref="Attempts"/> times); one that never
        /// settles is withheld (false), so the caller links nowhere it can't vouch for. <paramref name="state"/> is the state
        /// the published read began under (null: nothing may be kept).
        /// </summary>
        private bool Settled<T>(Func<T> read, ViewerLinks? page, out T value, out State? state, out string topology)
        {
            for (var attempt = 0; attempt < Attempts; attempt++)
            {
                var marks = Marks();
                var at = Clock();
                var before = page?.Topology() ?? string.Empty;
                var answer = read();
                if (Marks() == marks && (page == null || string.Equals(page.TopologyNow(), before, StringComparison.Ordinal)))
                {
                    value = answer;
                    state = marks.Revision is long revision ? new State(revision, marks.Changes, at) : null;
                    topology = before;
                    return true;
                }
            }

            value = default!;
            state = null;
            topology = string.Empty;
            return false;
        }

        /// <summary>How many times a read that crossed a library change is read again before it is withheld.</summary>
        private const int Attempts = 3;

        /// <summary>The library person with this TMDB id (any viewer), with its image tag; kept per library state.</summary>
        private (Guid? Id, string? Tag) LibraryPerson(string name, int tmdb)
        {
            var key = tmdb.ToString(CultureInfo.InvariantCulture) + "|" + name;
            if (_people.TryGetValue(key, out var hit) && Fresh(hit.State, Now())) return (hit.Id, hit.Tag);
            if (!Settled(() => ReadPerson(name, tmdb), null, out var person, out var state, out _)) return (null, null);
            if (state is { } kept)
            {
                if (_people.Count >= MaxEntries) _people.Clear();
                _people[key] = (kept, person.Id, person.Tag);
            }

            return person;
        }

        private (Guid? Id, string? Tag) ReadPerson(string name, int tmdb)
        {
            try
            {
                // Jellyfin keys people by name; the TMDB id tells a namesake apart (no id: not the same person).
                if (_library.GetPerson(name) is { } person
                    && string.Equals(person.GetProviderId(MetadataProvider.Tmdb), tmdb.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal))
                {
                    var tag = _images != null && person.GetImageInfo(ImageType.Primary, 0) is { } image ? _images.GetImageCacheTag(person, image) : null;
                    return (person.Id, tag);
                }
            }
            catch (Exception)
            {
                // Not resolvable now: the person's own page.
            }

            return (null, null);
        }

        /// <summary>True when the viewer finds at least one movie or series behind a library genre, studio or tag.</summary>
        private bool Finds(User viewer, string viewerRevision, ViewerLinks page, string kind, string name, Func<InternalItemsQuery, InternalItemsQuery> filter)
        {
            var key = string.Join('|', viewer.Id.ToString("N", CultureInfo.InvariantCulture), viewerRevision, kind, name);
            if (page.Topology() is not { } topology) return false;
            if (_visible.TryGetValue(key, out var hit) && Fresh(hit.State, Now()) && string.Equals(hit.Topology, topology, StringComparison.Ordinal)) return hit.Found;
            bool Read()
            {
                try
                {
                    // The viewer's own query: their libraries and parental rules, as the list page would apply them. Only
                    // existence is asked: ids, with Jellyfin's own user filtering, no item read.
                    var ids = _library.GetItemIds(filter(new InternalItemsQuery(viewer)
                    {
                        IncludeItemTypes = Titles,
                        Recursive = true,
                        Limit = 1,
                        DtoOptions = new DtoOptions(false),
                    }));
                    return ids != null && ids.Count > 0;
                }
                catch (Exception)
                {
                    return false;
                }
            }

            if (!Settled(Read, page, out var found, out var state, out var read)) return false;
            Keep(key, state, read, found);
            return found;
        }

        /// <summary>True when Jellyfin lets the viewer open this library item (kept like <see cref="Finds"/>).</summary>
        private bool Opens(User viewer, string viewerRevision, ViewerLinks page, Guid id)
        {
            var key = string.Join('|', viewer.Id.ToString("N", CultureInfo.InvariantCulture), viewerRevision, "open", id.ToString("N", CultureInfo.InvariantCulture));
            if (page.Topology() is not { } topology) return false;
            if (_visible.TryGetValue(key, out var hit) && Fresh(hit.State, Now()) && string.Equals(hit.Topology, topology, StringComparison.Ordinal)) return hit.Found;
            bool Read()
            {
                try
                {
                    return _library.GetItemById<BaseItem>(id, viewer) != null;
                }
                catch (Exception)
                {
                    return false;
                }
            }

            if (!Settled(Read, page, out var opens, out var state, out var read)) return false;
            Keep(key, state, read, opens);
            return opens;
        }

        private void Keep(string key, State? state, string topology, bool found)
        {
            if (state is not { } kept) return;
            if (_visible.Count >= MaxEntries)
            {
                var now = Now();
                foreach (var held in _visible.ToArray())
                {
                    if (!Fresh(held.Value.State, now)) _visible.TryRemove(held.Key, out _);
                }

                // Still full of live answers: start over (each refills at one read per name).
                if (_visible.Count >= MaxEntries) _visible.Clear();
            }

            _visible[key] = (kept, topology, found);
        }

        /// <summary>The library's genre or studio of this name (never created), or null; kept per library state.</summary>
        private Guid? LibraryName(string name, bool genre)
        {
            var key = (genre ? "g|" : "s|") + name;
            if (_names.TryGetValue(key, out var hit) && Fresh(hit.State, Now())) return hit.Id;
            Guid? Read()
            {
                try
                {
                    var id = genre ? _library.GetGenreId(name) : _library.GetStudioId(name);
                    var item = _library.GetItemById(id);
                    return genre ? (item is Genre ? id : null) : (item is Studio ? id : null);
                }
                catch (Exception)
                {
                    return null;
                }
            }

            if (!Settled(Read, null, out var found, out var state, out _)) return null;
            if (state is { } kept)
            {
                if (_names.Count >= MaxEntries) _names.Clear();
                _names[key] = (kept, found);
            }

            return found;
        }

        /// <summary>The library state an answer was read under: the library revision, the item changes seen, and when.</summary>
        private readonly record struct State(long Revision, long Changes, DateTime At);

        private sealed class ViewerLinks : ITitleLinks
        {
            private readonly NativeDetailsLinks _owner;
            private readonly User _viewer;
            private readonly string _revision;
            private readonly string _serverId;
            private readonly LinkDiscovery _discovery;
            private string? _topology;

            public ViewerLinks(NativeDetailsLinks owner, User viewer, string revision, string serverId, LinkDiscovery discovery)
            {
                _owner = owner;
                _viewer = viewer;
                _revision = revision;
                _serverId = serverId;
                _discovery = discovery;
            }

            /// <summary>
            /// The library topology for this page, read before its first visibility answer and again after each read (<see
            /// cref="TopologyNow"/>): removing a location or disabling a library changes what the viewer finds without any
            /// item event. Null when it can't be read: then no library link is vouched for.
            /// </summary>
            internal string? Topology() => _topology ?? TopologyNow();

            /// <summary>The library topology read now (and kept as this page's), or null when it can't be read.</summary>
            internal string? TopologyNow()
            {
                try
                {
                    return _topology = Acquire.ArrJellyfinView.TopologyOf(_owner._library);
                }
                catch (Exception)
                {
                    return _topology = null;
                }
            }

            public (Guid Id, string? ImageTag)? Person(string name, int tmdb)
            {
                if (string.IsNullOrWhiteSpace(name) || tmdb <= 0) return null;
                var (id, tag) = _owner.LibraryPerson(name, tmdb);
                if (id is not { } found) return null;
                // Jellyfin's own check for the viewer (the person page native would open).
                return _owner.Opens(_viewer, _revision, this, found) ? (found, tag) : null;
            }

            public Guid? Genre(string name, int tmdb)
            {
                if (string.IsNullOrWhiteSpace(name)) return null;
                if (_owner.LibraryName(name, genre: true) is { } id
                    && _owner.Finds(_viewer, _revision, this, "genre", name, q => { q.GenreIds = new[] { id }; return q; }))
                {
                    return id;
                }

                return _discovery.Genres && tmdb > 0 ? SyntheticId.Genre(tmdb).ToGuid(_serverId) : null;
            }

            public Guid? Studio(string name, int tmdb, bool network)
            {
                if (string.IsNullOrWhiteSpace(name)) return null;
                if (_owner.LibraryName(name, genre: false) is { } id
                    && _owner.Finds(_viewer, _revision, this, "studio", name, q => { q.StudioIds = new[] { id }; return q; }))
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
                return _discovery.Tags || _owner.Finds(_viewer, _revision, this, "tag", name, q => { q.Tags = new[] { name }; return q; });
            }
        }
    }
}
#endif
