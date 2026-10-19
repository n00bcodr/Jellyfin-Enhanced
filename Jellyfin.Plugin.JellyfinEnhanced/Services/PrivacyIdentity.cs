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
/// from each candidate BoxSet's linked children, never from ancestry.
/// </summary>
public static class PrivacyIdentities
{
    private static readonly TimeSpan MemberTtl = TimeSpan.FromSeconds(30);
    private static readonly ConcurrentDictionary<Guid, (HashSet<Guid> Members, DateTime At)> _members = new();

    /// <summary>Resolves every id in bounded batches (items, then owners). Unknown ids are absent from the answer.</summary>
    /// <param name="library">The library.</param>
    /// <param name="ids">The items to resolve.</param>
    /// <param name="viewer">The viewer whose watched state is read (optional).</param>
    /// <param name="userData">The user-data store (optional, with <paramref name="viewer"/>).</param>
    /// <param name="collections">Candidate collections whose linked children are matched (optional).</param>
    public static Dictionary<Guid, PrivacyIdentity> Resolve(ILibraryManager library, IEnumerable<Guid> ids, JUser? viewer = null,
        IUserDataManager? userData = null, IEnumerable<Guid>? collections = null)
    {
        var answer = new Dictionary<Guid, PrivacyIdentity>();
        var unique = ids.Where(id => id != Guid.Empty).Distinct().ToArray();
        if (unique.Length == 0) return answer;
        var options = new DtoOptions(false) { Fields = new[] { ItemFields.ProviderIds } };
        var items = new Dictionary<Guid, BaseItem>();
        foreach (var batch in unique.Chunk(2000))
            foreach (var item in library.GetItemList(new InternalItemsQuery { ItemIds = batch, DtoOptions = options }) ?? [])
                if (item != null) items[item.Id] = item;
        var owners = new Dictionary<Guid, BaseItem>();
        var missing = items.Values.Select(OwnerOf).Where(o => o != Guid.Empty && !items.ContainsKey(o)).Distinct().ToArray();
        foreach (var batch in missing.Chunk(2000))
            foreach (var owner in library.GetItemList(new InternalItemsQuery { ItemIds = batch, DtoOptions = options }) ?? [])
                if (owner != null) owners[owner.Id] = owner;
        // An extra of an episode belongs to the episode's series.
        var second = owners.Values.Concat(items.Values).Where(o => o is Episode or Season).Select(OwnerOf)
            .Where(o => o != Guid.Empty && !items.ContainsKey(o) && !owners.ContainsKey(o)).Distinct().ToArray();
        foreach (var batch in second.Chunk(2000))
            foreach (var owner in library.GetItemList(new InternalItemsQuery { ItemIds = batch, DtoOptions = options }) ?? [])
                if (owner != null) owners[owner.Id] = owner;
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
                ? userData.GetUserData(viewer, item is Episode ? item : title!)?.Played == true : null;
            answer[item.Id] = new PrivacyIdentity(item.Id, item.GetBaseItemKind(), owner.Id, TitleKey(owner),
                title != null && membership.TryGetValue(title.Id, out var sets) ? sets : Array.Empty<Guid>(), played, owner.GetBaseItemKind());
        }
        return answer;
    }

    private const string RequestKey = "__JE_PRIVACY_IDENTITIES";

    /// <summary>
    /// The viewer-independent identities, resolved once per request: the Hidden Content action filter and the delivery gate
    /// ask about the same items. Ids not resolved yet are looked up; the request's map is extended.
    /// </summary>
    public static Dictionary<Guid, PrivacyIdentity> Resolve(ILibraryManager library, IEnumerable<Guid> ids, Microsoft.AspNetCore.Http.HttpContext? http)
    {
        var known = http?.Items.TryGetValue(RequestKey, out var cached) == true && cached is Dictionary<Guid, PrivacyIdentity> map ? map : new();
        var wanted = ids.Where(id => id != Guid.Empty).Distinct().ToArray();
        foreach (var pair in Resolve(library, wanted.Where(id => !known.ContainsKey(id)))) known[pair.Key] = pair.Value;
        if (http != null) http.Items[RequestKey] = known;
        return wanted.Where(known.ContainsKey).ToDictionary(id => id, id => known[id]);
    }

    /// <summary>The typed TMDB key of a movie or series; null for anything else or without a TMDB id.</summary>
    public static string? TitleKey(BaseItem? item)
        => HiddenContentPolicy.TitleIdentity(item is Movie ? "movie" : item is Series ? "tv" : null, item?.GetProviderId(MetadataProvider.Tmdb));

    /// <summary>A collection's members by its linked children (memoized briefly; a BoxSet is not its members' ancestor).</summary>
    public static IReadOnlySet<Guid> CollectionMembers(ILibraryManager library, Guid collection)
    {
        var now = DateTime.UtcNow;
        if (_members.TryGetValue(collection, out var hit) && now - hit.At < MemberTtl) return hit.Members;
        var members = new HashSet<Guid>();
        if (library.GetItemById(collection) is BoxSet set)
            foreach (var child in set.GetLinkedChildren()) if (child != null) members.Add(child.Id);
        if (_members.Count >= 1024) foreach (var pair in _members) if (now - pair.Value.At >= MemberTtl) _members.TryRemove(pair.Key, out _);
        _members[collection] = (members, now);
        return members;
    }

    /// <summary>Drops the membership memo (tests and library changes that must be visible at once).</summary>
    public static void ForgetCollections() => _members.Clear();

    private static Guid OwnerOf(BaseItem item) => item switch
    {
        Episode episode => episode.SeriesId,
        Season season => season.SeriesId,
        _ => item.OwnerId
    };
}
