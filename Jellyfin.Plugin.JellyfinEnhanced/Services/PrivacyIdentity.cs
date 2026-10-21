using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>
/// Which protected title a library item belongs to, as every privacy surface asks it: the item itself, the title that
/// owns it (a season's or episode's series, an extra's owner), that title's typed TMDB key, the guarded collections
/// that link it (linked children, as Jellyfin's BoxSets hold their members) and whether the viewer has watched it.
/// </summary>
/// <param name="ItemId">The library item.</param>
/// <param name="Kind">The item's kind.</param>
/// <param name="OwnerId">The owning title: the series of a season/episode, otherwise the item itself.</param>
/// <param name="TitleKey">The owning title's typed TMDB key ("movie:tmdb:1"/"tv:tmdb:2"), or null without one.</param>
/// <param name="Collections">The candidate collections (BoxSets) that link this movie (for an extra: that link its owning movie).</param>
/// <param name="Played">The viewer's watched state for a movie or episode (for an extra of a movie: the movie's); null when unknown or not applicable.</param>
/// <param name="OwnerKind">The owning title's kind (the item's own kind when it owns itself).</param>
public sealed record PrivacyIdentity(Guid ItemId, BaseItemKind Kind, Guid OwnerId, string? TitleKey, IReadOnlyList<Guid> Collections, bool? Played,
    BaseItemKind? OwnerKind = null)
{
    /// <summary>The series that owns a season or episode (or a series itself); empty for anything else.</summary>
    public Guid SeriesId => Kind is BaseItemKind.Series or BaseItemKind.Season or BaseItemKind.Episode || OwnerId != ItemId ? OwnerId : Guid.Empty;

    /// <summary>A stable per-item projection key for policy decisions made from this identity rather than a TMDB key.</summary>
    public string ProjectionKey => "jellyfin:item:" + ItemId.ToString("N");

    /// <summary>An extra (theme song or video, trailer, featurette) owned by another title: it follows its owner.</summary>
    public bool IsExtra => OwnerId != ItemId && Kind is not (BaseItemKind.Season or BaseItemKind.Episode);

    /// <summary>
    /// The identity of an item another title owns, from the owner's identity (a theme answer's OwnerId, the route's opened
    /// item): the owner's title key, its guarded collections and its watched state.
    /// </summary>
    /// <param name="owner">The owning title's identity.</param>
    /// <param name="itemId">The owned item.</param>
    /// <param name="kind">The owned item's kind.</param>
    public static PrivacyIdentity Owned(PrivacyIdentity owner, Guid itemId, BaseItemKind kind)
    {
        // An extra of an episode or season belongs to that episode's series (the title Spoiler Guard and Hidden Content name).
        var title = owner.Kind is BaseItemKind.Episode or BaseItemKind.Season ? owner.OwnerId : owner.ItemId;
        var titleKind = owner.Kind is BaseItemKind.Episode or BaseItemKind.Season ? owner.OwnerKind ?? BaseItemKind.Series : owner.Kind;
        return new PrivacyIdentity(itemId, kind, title, owner.TitleKey, owner.Kind == BaseItemKind.Movie ? owner.Collections : Array.Empty<Guid>(),
            owner.Kind == BaseItemKind.Movie ? owner.Played : null, titleKind);
    }
}

/// <summary>
/// The one identity resolver for every privacy surface (native DTOs, search hints, recommendation seeds, activity rows,
/// the Spoiler Guard context and Hidden Content's provider binding). Lookups are batched; collection membership is read
/// from each candidate BoxSet's linked children, never from ancestry. Every fact it reads (each item and owner, a
/// collection's members, the viewer's watched state) is recorded in the current attempt's read-set before it is read, and
/// remembered by the input log, so a change the judgment may have missed is logged against what was remembered.
/// </summary>
public static class PrivacyIdentities
{
    private static readonly TimeSpan MemberTtl = TimeSpan.FromSeconds(30);
    private static readonly ConcurrentDictionary<Guid, (HashSet<Guid> Members, DateTime At)> _members = new();
    private static readonly object _membersLock = new();

    static PrivacyIdentities()
    {
        // A collection's members are a verdict input: its memo follows the collection's own changes.
        PrivacyInputs.CollectionChanged += collection => { lock (_membersLock) _members.TryRemove(collection, out _); };
    }

    private static readonly DtoOptions _options = new(false) { Fields = new[] { ItemFields.ProviderIds } };

    /// <summary>Loads items by id in bounded batches, recording each id's library facts as read first.</summary>
    private static void Load(ILibraryManager library, IEnumerable<Guid> ids, Dictionary<Guid, BaseItem> into)
    {
        foreach (var batch in ids.Chunk(2000))
        {
            PrivacyReadSet.Current?.Library(batch);
            foreach (var item in library.GetItemList(new InternalItemsQuery { ItemIds = batch, DtoOptions = _options }) ?? [])
                if (item != null)
                {
                    into[item.Id] = item;
                }
        }
    }

    /// <summary>Resolves every id in bounded batches (items, then owners). Unknown ids are absent from the answer.</summary>
    /// <param name="library">The library.</param>
    /// <param name="ids">The items to resolve.</param>
    /// <param name="viewer">The viewer whose watched state is read (optional).</param>
    /// <param name="userData">The user-data store (optional, with <paramref name="viewer"/>).</param>
    /// <param name="collections">Candidate collections whose linked children are matched (optional).</param>
    public static Dictionary<Guid, PrivacyIdentity> Resolve(ILibraryManager library, IEnumerable<Guid> ids, JUser? viewer = null,
        IUserDataManager? userData = null, IEnumerable<Guid>? collections = null)
        => Resolve(library, ids, viewer, userData, collections, null);

    /// <summary>
    /// As <see cref="Resolve(ILibraryManager, IEnumerable{Guid}, JUser?, IUserDataManager?, IEnumerable{Guid}?)"/>, also
    /// giving the facts each judged item and owner was judged by (<paramref name="facts"/>), so a later reuse of the
    /// resolution can have them compared with the live items.
    /// </summary>
    internal static Dictionary<Guid, PrivacyIdentity> Resolve(ILibraryManager library, IEnumerable<Guid> ids, JUser? viewer,
        IUserDataManager? userData, IEnumerable<Guid>? collections, Dictionary<Guid, PrivacyFacts>? facts)
    {
        var answer = new Dictionary<Guid, PrivacyIdentity>();
        var unique = ids.Where(id => id != Guid.Empty).Distinct().ToArray();
        if (unique.Length == 0) return answer;
        var items = new Dictionary<Guid, BaseItem>();
        Load(library, unique, items);
        // A stored row that names no owner but sits where the host's own naming rules put an extra is judged by the host's
        // live item: 10.11 attaches an extra found in another library's folder to its owner in memory (and in the owner's
        // extras) without saving the extra's own row, so the row the batched lookup reads lags what the host serves.
        foreach (var item in items.Values.ToList())
            if (item.OwnerId == Guid.Empty && item is not (Movie or Series or Season or Episode or Folder) && PrivacyValues.SitsLikeAnExtra(item)
                && PrivacyReads.Item(library, item.Id) is { } live && live.OwnerId != Guid.Empty)
                items[item.Id] = live;
        // The facts each judged item (its live view where the host serves one) is read with are remembered before they are read.
        foreach (var item in items.Values) PrivacyInputs.Know(library, item);
        var listed = ListedOwners(library, items.Values);
        Guid OwnerOf(BaseItem item) => PrivacyIdentities.OwnerOf(item) is var own && own != Guid.Empty ? own : listed.GetValueOrDefault(item.Id);
        var owners = new Dictionary<Guid, BaseItem>();
        Load(library, items.Values.Select(OwnerOf).Where(o => o != Guid.Empty && !items.ContainsKey(o)).Distinct().ToArray(), owners);
        // An extra of an episode belongs to the episode's series.
        Load(library, owners.Values.Concat(items.Values).Where(o => o is Episode or Season).Select(OwnerOf)
            .Where(o => o != Guid.Empty && !items.ContainsKey(o) && !owners.ContainsKey(o)).Distinct().ToArray(), owners);
        foreach (var owner in owners.Values) PrivacyInputs.Know(library, owner);
        // What each judged item and owner was judged by (an extra by the owner the rule gave it): compared with the live
        // items at the gate.
        var reads = PrivacyReadSet.Current;
        foreach (var item in items.Values.Concat(owners.Values))
        {
            // An extra's owner as the rule gave it (an episode's or season's series is a fact of its own).
            Guid? own = item is Episode or Season ? null : OwnerOf(item);
            reads?.Item(library, item, own);
            if (facts != null) facts[item.Id] = PrivacyFacts.Of(item, own);
        }
        BaseItem? Find(Guid id) => items.TryGetValue(id, out var hit) ? hit : owners.GetValueOrDefault(id);
        var membership = new Dictionary<Guid, List<Guid>>();
        foreach (var collection in collections?.Where(c => c != Guid.Empty).Distinct() ?? [])
            foreach (var member in CollectionMembers(library, collection))
                if (Find(member) != null) (membership.TryGetValue(member, out var list) ? list : membership[member] = new()).Add(collection);
        foreach (var item in items.Values)
        {
            var owner = item;
            for (var hop = 0; hop < 2 && OwnerOf(owner) is var next && next != Guid.Empty && Find(next) is { } found; hop++) owner = found;
            // An extra of a movie is the movie's: its collections and its watched state.
            var title = item is Movie ? item : owner is Movie ? owner : null;
            bool? played = viewer != null && userData != null && (item is Movie or Episode || title != null)
                ? PrivacyReads.UserData(userData, viewer, item is Episode ? item : title!)?.Played == true : null;
            answer[item.Id] = new PrivacyIdentity(item.Id, item.GetBaseItemKind(), owner.Id, TitleKey(owner),
                title != null && membership.TryGetValue(title.Id, out var sets) ? sets : Array.Empty<Guid>(), played, owner.GetBaseItemKind());
        }
        return answer;
    }

    /// <summary>
    /// The identity of a library item a caller already holds (one item, by the same rules as <see cref="Resolve(ILibraryManager, IEnumerable{Guid}, JUser?, IUserDataManager?, IEnumerable{Guid}?)"/>):
    /// a season's or episode's series owns it even when the series entity cannot be loaded; an extra's owner is
    /// followed up to two hops.
    /// </summary>
    public static PrivacyIdentity Of(ILibraryManager library, BaseItem item, JUser? viewer = null, IUserDataManager? userData = null)
    {
        var reads = PrivacyReadSet.Current;
        reads?.Library(item.Id);
        PrivacyInputs.Know(library, item);
        var listed = ListedOwners(library, [item]);
        Guid OwnerOf(BaseItem one) => PrivacyIdentities.OwnerOf(one) is var own && own != Guid.Empty ? own : listed.GetValueOrDefault(one.Id);
        reads?.Item(library, item, item is Episode or Season ? null : OwnerOf(item));
        var owner = item;
        var ownerId = OwnerOf(item) is var first && first != Guid.Empty ? first : item.Id;
        reads?.Library(ownerId);
        for (var hop = 0; hop < 2 && OwnerOf(owner) is var next && next != Guid.Empty && PrivacyReads.Item(library, next) is { } found; hop++)
        {
            PrivacyInputs.Know(library, found);
            owner = found;
        }
        if (owner != item) ownerId = owner.Id;
        var title = item is Movie ? item : owner is Movie ? owner : null;
        bool? played = viewer != null && userData != null && (item is Movie or Episode || title != null)
            ? PrivacyReads.UserData(userData, viewer, item is Episode ? item : title!)?.Played == true : null;
        var ownerKind = owner != item ? owner.GetBaseItemKind() : item is Episode or Season ? BaseItemKind.Series : item.GetBaseItemKind();
        return new PrivacyIdentity(item.Id, item.GetBaseItemKind(), ownerId, TitleKey(owner == item && item is Episode or Season ? null : owner), Array.Empty<Guid>(), played, ownerKind);
    }

    private const string RequestKey = "__JE_PRIVACY_IDENTITIES";

    /// <summary>A request's resolved identities, each with the input tick it was resolved at.</summary>
    private sealed class RequestIdentities
    {
        public Dictionary<Guid, (PrivacyIdentity Identity, long At)> Known { get; } = new();

        /// <summary>The facts each resolved item and owner was judged by.</summary>
        public Dictionary<Guid, PrivacyFacts> Facts { get; } = new();
    }

    /// <summary>
    /// The viewer-independent identities, resolved once per request: the Hidden Content action filter and the delivery gate
    /// ask about the same items. Ids not resolved yet are looked up; the request's map is extended. A reused identity is
    /// recorded in the current attempt's read-set as of when it was resolved (a rebuild discards the map first,
    /// <see cref="Discard"/>).
    /// </summary>
    public static Dictionary<Guid, PrivacyIdentity> Resolve(ILibraryManager library, IEnumerable<Guid> ids, Microsoft.AspNetCore.Http.HttpContext? http)
    {
        var known = http?.Items.TryGetValue(RequestKey, out var cached) == true && cached is RequestIdentities map ? map : new RequestIdentities();
        var wanted = ids.Where(id => id != Guid.Empty).Distinct().ToArray();
        var at = PrivacyInputs.Now;
        foreach (var pair in Resolve(library, wanted.Where(id => !known.Known.ContainsKey(id)), null, null, null, known.Facts)) known.Known[pair.Key] = (pair.Value, at);
        if (http != null) http.Items[RequestKey] = known;
        var reads = PrivacyReadSet.Current;
        var answer = new Dictionary<Guid, PrivacyIdentity>();
        foreach (var id in wanted)
        {
            if (!known.Known.TryGetValue(id, out var hit)) continue;
            if (reads != null)
            {
                // A reused resolution: its own facts, observed when it was resolved (nothing else in the answer is
                // backdated), and compared with the live items at the gate.
                reads.Library(id, hit.At);
                reads.Library(hit.Identity.OwnerId, hit.At);
                if (known.Facts.TryGetValue(id, out var facts)) reads.Item(library, id, facts);
                if (known.Facts.TryGetValue(hit.Identity.OwnerId, out var ownerFacts)) reads.Item(library, hit.Identity.OwnerId, ownerFacts);
            }
            answer[id] = hit.Identity;
        }
        return answer;
    }

    /// <summary>Drops a request's resolved identities (a rebuild resolves every item again).</summary>
    public static void Discard(Microsoft.AspNetCore.Http.HttpContext? http) => http?.Items.Remove(RequestKey);

    /// <summary>The typed TMDB key of a movie or series; null for anything else or without a TMDB id.</summary>
    public static string? TitleKey(BaseItem? item)
        => HiddenContentPolicy.TitleIdentity(item is Movie ? "movie" : item is Series ? "tv" : null, item?.GetProviderId(MetadataProvider.Tmdb));

    /// <summary>
    /// A collection's members by its linked children (memoized until the collection changes; a BoxSet is not its members'
    /// ancestor). The collection and its members are recorded in the current attempt's read-set.
    /// </summary>
    public static IReadOnlySet<Guid> CollectionMembers(ILibraryManager library, Guid collection)
    {
        var reads = PrivacyReadSet.Current;
        reads?.Library(collection);
        var now = DateTime.UtcNow;
        if (_members.TryGetValue(collection, out var hit) && now - hit.At < MemberTtl)
        {
            reads?.Library(hit.Members);
            return hit.Members;
        }
        var since = PrivacyInputs.Now;
        var members = new HashSet<Guid>();
        if (library.GetItemById(collection) is BoxSet set)
            foreach (var child in set.GetLinkedChildren()) if (child != null) members.Add(child.Id);
        reads?.Library(members);
        lock (_membersLock)
        {
            // A members list read while the collection changed is not memoized (the change's event may already have run).
            if (PrivacyInputs.LibraryChangesSince(since) is { } changed && !changed.Contains(collection))
            {
                if (_members.Count >= 1024) foreach (var pair in _members) if (now - pair.Value.At >= MemberTtl) _members.TryRemove(pair.Key, out _);
                _members[collection] = (members, now);
            }
        }
        return members;
    }

    /// <summary>Drops the membership memo (tests and library changes that must be visible at once).</summary>
    public static void ForgetCollections()
    {
        lock (_membersLock) _members.Clear();
    }

    /// <summary>
    /// The title an item is an extra of (its own owner, or on 10.11 the owner that lists it in its extras), or empty: the
    /// one ownership rule every site that names or judges an extra asks.
    /// </summary>
    public static Guid ExtraOwner(ILibraryManager? library, BaseItem item)
    {
        if (item is Episode or Season) return Guid.Empty;
        PrivacyReadSet.Current?.Library(item.Id);
        if (item.OwnerId != Guid.Empty) return item.OwnerId;
        return library == null ? Guid.Empty : ListedOwners(library, [item]).GetValueOrDefault(item.Id);
    }

    /// <summary>
    /// The owner the ownership rule gives a live item whose row names none (the gate's comparison): the host's live item's
    /// own owner where it serves one, else 10.11's listing owner (<paramref name="folders"/>: one lookup per folder).
    /// </summary>
    internal static Guid ExtraOwner(ILibraryManager library, BaseItem item, Dictionary<string, (BaseItem Owner, HashSet<Guid> Extras)?> folders)
    {
        if (item is Episode or Season || item.OwnerId != Guid.Empty) return OwnerOf(item);
        if (item is not (Movie or Series or Folder) && PrivacyValues.SitsLikeAnExtra(item) && library.GetItemById(item.Id) is { OwnerId: var live } && live != Guid.Empty) return live;
        return ListedOwners(library, [item], folders).GetValueOrDefault(item.Id);
    }

    /// <summary>
    /// What kind of extra an item is: the host's own extra type, or where the item's row has none (10.11's attached-in-memory
    /// extra), the kind the host's naming rules give its file (its extras folder or suffix). Null when neither says.
    /// </summary>
    public static ExtraType? ExtraKind(BaseItem item) => item.ExtraType ?? PrivacyValues.NamedExtraType(item);

    /// <summary>
    /// The owners the host lists items under without the items naming them: 10.11 can attach an extra found in another
    /// library's folder to its owner (saving it in the owner's extras) without ever saving the extra's own owner, and after a
    /// restart it still serves the item as that owner's extra. Such an item is the owner's. One folder lookup per distinct
    /// folder of the batch, each owner's extras read once as a set. Empty on 12, which saves both.
    /// </summary>
    private static Dictionary<Guid, Guid> ListedOwners(ILibraryManager library, IEnumerable<BaseItem> items,
        Dictionary<string, (BaseItem Owner, HashSet<Guid> Extras)?>? shared = null)
    {
        var listed = new Dictionary<Guid, Guid>();
#if JF10
        // Shared with the rest of the answer's attempt (naming, vocabulary); a batch of its own without one.
        var folders = shared ?? PrivacyReadSet.Current?.FolderOwners ?? new Dictionary<string, (BaseItem Owner, HashSet<Guid> Extras)?>(StringComparer.Ordinal);
        foreach (var item in items)
        {
            if (item.OwnerId != Guid.Empty || item is Movie or Series or Season or Episode or Folder) continue;
            foreach (var folder in PrivacyValues.ExtraOwnerFolders(item))
            {
                bool known;
                (BaseItem Owner, HashSet<Guid> Extras)? found;
                lock (folders) known = folders.TryGetValue(folder, out found);
                if (!known)
                {
                    found = null;
                    if (library.FindByPath(folder, null) is { } owner && owner is not Folder { IsRoot: true })
                    {
                        // Recorded and remembered before its extras are read.
                        PrivacyReadSet.Current?.Library(owner.Id);
                        PrivacyInputs.Know(library, owner);
                        found = (owner, new HashSet<Guid>(owner.ExtraIds ?? []));
                    }
                    lock (folders) folders[folder] = found;
                }
                if (found is { } listing && listing.Extras.Contains(item.Id))
                {
                    listed[item.Id] = listing.Owner.Id;
                    break;
                }
            }
        }
#endif
        return listed;
    }

    private static Guid OwnerOf(BaseItem item) => item switch
    {
        Episode episode => episode.SeriesId,
        Season season => season.SeriesId,
        _ => item.OwnerId
    };
}
