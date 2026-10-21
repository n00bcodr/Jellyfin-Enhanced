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
/// the Spoiler Guard context and Hidden Content's provider binding). Lookups are batched and read the host's current view of
/// each item (<see cref="PrivacyHostView"/>); collection membership is read from each candidate BoxSet's linked children,
/// never from ancestry. Everything a judgment consumes is a fact of the current attempt's read-set (each item and every
/// owner hop with the facts it was judged by, an owner or item the library did not have, a title's membership of the
/// candidate collections, the viewer's watched state), and a reused resolution replays that complete proof.
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

    /// <summary>
    /// Loads items by id as the host serves them now (<see cref="PrivacyHostView"/>, in bounded batches): each found item is
    /// remembered by the input log; an id the library does not have is recorded as absent (absence is a fact).
    /// </summary>
    private static void Load(ILibraryManager library, IReadOnlyCollection<Guid> ids, Dictionary<Guid, BaseItem> into)
    {
        if (ids.Count == 0) return;
        var found = PrivacyHostView.Items(library, ids);
        foreach (var id in ids)
        {
            if (found.TryGetValue(id, out var item)) { into[id] = item; PrivacyInputs.Know(library, item); }
            else PrivacyReadSet.Current?.Absent(library, id);
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
    /// giving, for each resolved id, every library fact its identity was decided by (<paramref name="chains"/>: the item, each
    /// owner hop, and an owner the library did not have), so a later reuse of the resolution replays its complete proof.
    /// </summary>
    internal static Dictionary<Guid, PrivacyIdentity> Resolve(ILibraryManager library, IEnumerable<Guid> ids, JUser? viewer,
        IUserDataManager? userData, IEnumerable<Guid>? collections, Dictionary<Guid, List<(Guid Id, PrivacyFacts? Facts)>>? chains)
    {
        var answer = new Dictionary<Guid, PrivacyIdentity>();
        var unique = ids.Where(id => id != Guid.Empty).Distinct().ToArray();
        if (unique.Length == 0) return answer;
        var items = new Dictionary<Guid, BaseItem>();
        Load(library, unique, items);
        var listed = ListedOwners(library, items.Values);
        Guid OwnerOf(BaseItem item) => PrivacyIdentities.OwnerOf(item) is var own && own != Guid.Empty ? own : listed.GetValueOrDefault(item.Id);
        var owners = new Dictionary<Guid, BaseItem>();
        Load(library, items.Values.Select(OwnerOf).Where(o => o != Guid.Empty && !items.ContainsKey(o)).Distinct().ToArray(), owners);
        // An extra of an episode belongs to the episode's series.
        Load(library, owners.Values.Concat(items.Values).Where(o => o is Episode or Season).Select(OwnerOf)
            .Where(o => o != Guid.Empty && !items.ContainsKey(o) && !owners.ContainsKey(o)).Distinct().ToArray(), owners);
        // What each judged item and owner was judged by (an extra by the owner the rule gave it): compared with the live
        // items at every check.
        var reads = PrivacyReadSet.Current;
        var judged = new Dictionary<Guid, PrivacyFacts>();
        foreach (var item in items.Values.Concat(owners.Values))
        {
            // An extra's owner as the rule gave it (an episode's or season's series is a fact of its own).
            Guid? own = item is Episode or Season ? null : OwnerOf(item);
            var facts = PrivacyFacts.Of(item, own);
            judged[item.Id] = facts;
            reads?.Item(library, item.Id, facts);
        }
        BaseItem? Find(Guid id) => items.TryGetValue(id, out var hit) ? hit : owners.GetValueOrDefault(id);
        var candidates = collections?.Where(c => c != Guid.Empty).Distinct().ToArray() ?? [];
        foreach (var item in items.Values)
        {
            var chain = chains != null ? new List<(Guid, PrivacyFacts?)> { (item.Id, judged[item.Id]) } : null;
            var (owner, ownerId, ownerKind) = Owner(item, OwnerOf, Find, chain is null ? null : id => chain.Add((id, judged.TryGetValue(id, out var f) ? f : null)));
            // An extra of a movie is the movie's: its collections and its watched state.
            var title = item is Movie ? item : owner is Movie ? owner : null;
            bool? played = viewer != null && userData != null && (item is Movie or Episode || title != null)
                ? PrivacyReads.UserData(userData, viewer, item is Episode ? item : title!)?.Played == true : null;
            var sets = title != null && candidates.Length > 0 ? Containing(library, title.Id, candidates) : (IReadOnlyList<Guid>)Array.Empty<Guid>();
            answer[item.Id] = new PrivacyIdentity(item.Id, item.GetBaseItemKind(), ownerId, TitleKey(owner == item && item is Episode or Season ? null : owner),
                sets, played, ownerKind);
            if (chains != null) chains[item.Id] = chain!;
        }
        return answer;
    }

    /// <summary>
    /// The title that owns <paramref name="item"/>, followed up to two hops (an extra of an episode belongs to the episode's
    /// series). An owner the item names explicitly stays its owner even when the owner's own row cannot be loaded (its
    /// absence is a recorded fact, never proof that the item owns itself): the owner id is kept, of kind Series for an
    /// episode's or season's owner.
    /// </summary>
    private static (BaseItem Owner, Guid OwnerId, BaseItemKind OwnerKind) Owner(BaseItem item, Func<BaseItem, Guid> ownerOf, Func<Guid, BaseItem?> find, Action<Guid>? hop)
    {
        var owner = item;
        var ownerId = item.Id;
        var ownerKind = item is Episode or Season ? BaseItemKind.Series : item.GetBaseItemKind();
        for (var step = 0; step < 2; step++)
        {
            var next = ownerOf(owner);
            if (next == Guid.Empty || next == owner.Id) break;
            hop?.Invoke(next);
            ownerId = next;
            if (find(next) is not { } found)
            {
                // Known by id only: an episode's or season's owner is its series; an extra's owner keeps the kind it can be.
                ownerKind = owner is Episode or Season ? BaseItemKind.Series : ownerKind;
                break;
            }
            owner = found;
            ownerKind = found.GetBaseItemKind();
        }
        return (owner, ownerId, ownerKind);
    }

    /// <summary>
    /// The identity of a library item a caller already holds (one item, by the same rules as <see cref="Resolve(ILibraryManager, IEnumerable{Guid}, JUser?, IUserDataManager?, IEnumerable{Guid}?)"/>,
    /// judged as the host serves it now): a season's or episode's series owns it even when the series entity cannot be
    /// loaded; an extra's owner is followed up to two hops.
    /// </summary>
    public static PrivacyIdentity Of(ILibraryManager library, BaseItem item, JUser? viewer = null, IUserDataManager? userData = null)
    {
        // The host's current view of the item (the caller's instance may be an older cached one): the same view every
        // check compares with.
        var current = PrivacyHostView.Item(library, item.Id) ?? item;
        PrivacyInputs.Know(library, current);
        var listed = ListedOwners(library, [current]);
        Guid OwnerOf(BaseItem one) => PrivacyIdentities.OwnerOf(one) is var own && own != Guid.Empty ? own : listed.GetValueOrDefault(one.Id);
        PrivacyReadSet.Current?.Item(library, current, current is Episode or Season ? null : OwnerOf(current));
        var (owner, ownerId, ownerKind) = Owner(current, OwnerOf, id => PrivacyReads.Item(library, id) is { } found ? Known(library, found) : null, null);
        var title = current is Movie ? current : owner is Movie ? owner : null;
        bool? played = viewer != null && userData != null && (current is Movie or Episode || title != null)
            ? PrivacyReads.UserData(userData, viewer, current is Episode ? current : title!)?.Played == true : null;
        return new PrivacyIdentity(current.Id, current.GetBaseItemKind(), ownerId, TitleKey(owner == current && current is Episode or Season ? null : owner), Array.Empty<Guid>(), played, ownerKind);
    }

    private static BaseItem Known(ILibraryManager library, BaseItem item)
    {
        PrivacyInputs.Know(library, item);
        return item;
    }

    private const string RequestKey = "__JE_PRIVACY_IDENTITIES";

    /// <summary>A request's resolved identities, each with the complete library proof it was decided by.</summary>
    private sealed class RequestIdentities
    {
        public Dictionary<Guid, PrivacyIdentity> Known { get; } = new();

        /// <summary>Every library fact each resolved identity was decided by (the item, each owner hop, absences).</summary>
        public Dictionary<Guid, List<(Guid Id, PrivacyFacts? Facts)>> Chains { get; } = new();
    }

    /// <summary>
    /// The viewer-independent identities, resolved once per request: the Hidden Content action filter and the delivery gate
    /// ask about the same items. Ids not resolved yet are looked up; the request's map is extended. A reused identity replays
    /// its complete proof (the item, every owner hop and any owner the library did not have) into the current attempt; a
    /// rebuild discards the map first (<see cref="Discard"/>).
    /// </summary>
    public static Dictionary<Guid, PrivacyIdentity> Resolve(ILibraryManager library, IEnumerable<Guid> ids, Microsoft.AspNetCore.Http.HttpContext? http)
    {
        var known = http?.Items.TryGetValue(RequestKey, out var cached) == true && cached is RequestIdentities map ? map : new RequestIdentities();
        var wanted = ids.Where(id => id != Guid.Empty).Distinct().ToArray();
        var fresh = wanted.Where(id => !known.Known.ContainsKey(id)).ToArray();
        var chains = new Dictionary<Guid, List<(Guid Id, PrivacyFacts? Facts)>>();
        foreach (var pair in Resolve(library, fresh, null, null, null, chains)) known.Known[pair.Key] = pair.Value;
        foreach (var (id, chain) in chains) known.Chains[id] = chain;
        if (http != null) http.Items[RequestKey] = known;
        var reads = PrivacyReadSet.Current;
        var reused = new HashSet<Guid>(wanted.Except(fresh));
        var answer = new Dictionary<Guid, PrivacyIdentity>();
        foreach (var id in wanted)
        {
            if (!known.Known.TryGetValue(id, out var hit)) continue;
            // A reused resolution: every fact it was decided by, compared with the live library at every check.
            if (reads != null && reused.Contains(id) && known.Chains.TryGetValue(id, out var proof))
                foreach (var (link, facts) in proof)
                    if (facts is { } judged) reads.Item(library, link, judged); else reads.Absent(library, link);
            answer[id] = hit;
        }
        // An id that resolved to nothing earlier in the request is still absent (or is not, and the check sees it).
        if (reads != null) foreach (var id in reused.Where(id => !known.Known.ContainsKey(id))) reads.Absent(library, id);
        return answer;
    }

    /// <summary>Drops a request's resolved identities (a rebuild resolves every item again).</summary>
    public static void Discard(Microsoft.AspNetCore.Http.HttpContext? http) => http?.Items.Remove(RequestKey);

    /// <summary>The typed TMDB key of a movie or series; null for anything else or without a TMDB id.</summary>
    public static string? TitleKey(BaseItem? item)
        => HiddenContentPolicy.TitleIdentity(item is Movie ? "movie" : item is Series ? "tv" : null, item?.GetProviderId(MetadataProvider.Tmdb));

    /// <summary>
    /// A collection's members by its linked children (memoized until the collection changes, or until a check finds the
    /// memo no longer matches the library; a BoxSet is not its members' ancestor). Callers record what they consume of it
    /// (<see cref="Containing"/>, the membership predicate of a title).
    /// </summary>
    public static IReadOnlySet<Guid> CollectionMembers(ILibraryManager library, Guid collection)
    {
        var now = DateTime.UtcNow;
        if (_members.TryGetValue(collection, out var hit) && now - hit.At < MemberTtl) return hit.Members;
        var since = PrivacyInputs.Now;
        var members = MembersNow(library, collection);
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

    /// <summary>A collection's members as the host holds them now (its linked children; unmemoized).</summary>
    internal static HashSet<Guid> MembersNow(ILibraryManager library, Guid collection) => PrivacyReadSet.Unrecorded(() => Members(library, collection));

    private static HashSet<Guid> Members(ILibraryManager library, Guid collection)
    {
        var members = new HashSet<Guid>();
        if (PrivacyHostView.Item(library, collection) is BoxSet set)
        {
            // Linked by id (a BoxSet's links name their items); a link the host resolves by path is resolved by the host.
            if (set.LinkedChildren is { } links && links.All(l => l?.ItemId is { } id && id != Guid.Empty))
                foreach (var link in links) members.Add(link.ItemId!.Value);
            else
                foreach (var child in set.GetLinkedChildren()) if (child != null) members.Add(child.Id);
        }
        return members;
    }

    /// <summary>Drops one collection's membership memo.</summary>
    internal static void ForgetCollection(Guid collection)
    {
        lock (_membersLock) _members.TryRemove(collection, out _);
    }

    /// <summary>
    /// Which of <paramref name="collections"/> link <paramref name="title"/> (in their order): the membership predicate a
    /// decision consumes, recorded as a fact compared with each collection's live links at every check (an unrelated member
    /// or a new order changes nothing).
    /// </summary>
    public static IReadOnlyList<Guid> Containing(ILibraryManager library, Guid title, IReadOnlyList<Guid> collections)
    {
        var containing = collections.Where(c => CollectionMembers(library, c).Contains(title)).ToList();
        PrivacyReads.Query("collections:" + title.ToString("N") + ":" + PrivacyReads.SetOf(collections), PrivacyReads.SetOf(containing),
            check => PrivacyReads.SetOf(collections.Where(c => check.Memo("members:" + c.ToString("N"), () => MembersNow(library, c)).Contains(title))),
            () => { foreach (var c in collections) ForgetCollection(c); });
        return containing;
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
                        // Remembered before its extras are read (the listing itself is part of each extra's facts).
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
