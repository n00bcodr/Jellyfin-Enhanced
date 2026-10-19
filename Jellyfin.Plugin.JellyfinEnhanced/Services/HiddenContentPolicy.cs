using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using MediaBrowser.Model.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>Immutable viewer presentation rules. Provider intent survives arrival, editions and reimport.</summary>
public sealed class HiddenContentPolicy
{
    private readonly Dictionary<string, HashSet<string>> _items = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, HashSet<string>> _series = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, HashSet<string>> _titles = new(StringComparer.Ordinal);
    private readonly Dictionary<string, HashSet<string>> _titleItems = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, string> _libraryKeys = new(StringComparer.OrdinalIgnoreCase);
    private readonly HiddenContentSettings _settings;
    private readonly bool _master;
    private readonly bool _remove;

    /// <summary>Fingerprint of the effective rules and surface settings, without exposing private data.</summary>
    public string Revision { get; }

    /// <summary>Stable base revision used to protect full-document replacements from newer rule writes.</summary>
    public static string RulesRevision(UserHiddenContent data)
        => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(
            Newtonsoft.Json.JsonConvert.SerializeObject(data.Items.OrderBy(p => p.Key, StringComparer.Ordinal)))));

    private HiddenContentPolicy(UserHiddenContent? data, bool master, bool remove)
    {
        var settings = data?.Settings ?? new();
        _settings = new HiddenContentSettings { Enabled = settings.Enabled, FilterLibrary = settings.FilterLibrary,
            FilterDiscovery = settings.FilterDiscovery, FilterSearch = settings.FilterSearch, FilterUpcoming = settings.FilterUpcoming,
            FilterCalendar = settings.FilterCalendar, FilterRecommendations = settings.FilterRecommendations, FilterRequests = settings.FilterRequests,
            FilterNextUp = settings.FilterNextUp, FilterContinueWatching = settings.FilterContinueWatching };
        _master = master;
        _remove = remove;
        Revision = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(
            RulesRevision(data ?? new()) + Newtonsoft.Json.JsonConvert.SerializeObject(_settings) + master + remove)));
        foreach (var pair in data?.Items ?? new())
        {
            var entry = pair.Value;
            if (entry == null) continue;
            var scope = string.IsNullOrEmpty(entry.HideScope) ? "global" : entry.HideScope.ToLowerInvariant();
            if (!string.IsNullOrWhiteSpace(entry.ItemId))
            {
                Add(_items, NormalizeId(entry.ItemId), scope);
                if (entry.Type is "Movie" or "Series" && TitleIdentity(entry.Type, entry.TmdbId) == null)
                    Add(_titleItems, NormalizeId(entry.ItemId), scope);
                if (entry.Type.Equals("Series", StringComparison.OrdinalIgnoreCase)) Add(_series, NormalizeId(entry.ItemId), scope);
            }
            // Legacy tmdb-N rules require a known stored type. Never guess both namespaces.
            var key = TitleIdentity(entry.Type, entry.TmdbId) ?? CanonicalTitle(pair.Key);
            if (key != null) Add(_titles, key, scope);
        }
    }

    /// <summary>Builds an isolated policy without modifying the persisted document.</summary>
    public static HiddenContentPolicy Build(UserHiddenContent? data, bool master = true, bool remove = false) => new(data, master, remove);

    /// <summary>Loads strictly under the same lock as mutations. Unreadable state is retryable, never an empty policy.</summary>
    public static HiddenContentPolicy Load(UserConfigurationManager manager, Guid viewer, HttpContext? http = null, ILibraryManager? library = null)
    {
        var cacheKey = "__JE_TITLE_HIDES_" + viewer.ToString("N");
        if (http?.Items.TryGetValue(cacheKey, out var cached) == true && cached is HiddenContentPolicy hit) return hit;
        var config = JellyfinEnhanced.Instance?.Configuration;
        if (config?.HiddenContentEnabled != true && config?.RemoveContinueWatchingEnabled != true) return Build(null, false);
        HiddenContentPolicy policy;
        lock (manager.GetUserFileLock(viewer.ToString("N"), "hidden-content.json"))
            policy = Build(manager.GetUserConfigurationStrict<UserHiddenContent>(viewer.ToString("N"), "hidden-content.json"),
                config?.HiddenContentEnabled == true, config?.RemoveContinueWatchingEnabled == true);
        if (library != null && policy._titleItems.Count > 0)
            policy.BindLibraryIds(library, policy._titleItems.Keys.Select(id => Guid.TryParse(id, out var guid) ? guid : Guid.Empty));
        if (http != null) http.Items[cacheKey] = policy;
        return policy;
    }

    /// <summary>Canonical typed TMDB title key; children need their parent's provider id explicitly.</summary>
    public static string? TitleIdentity(string? type, string? tmdb) => ParseOwningTitle(type, tmdb, extended: false) is { } title ? title.Key : null;

    /// <summary>The owning title of a TMDB title, season or episode key ("42", "42:s1", "42:s1:e2"), as guarded routes receive it.</summary>
    public static string? OwningTitle(string? type, string? key) => ParseOwningTitle(type, key) is { } title ? title.Key : null;

    /// <summary>
    /// The one parser for title identities: every typed TMDB key, including the extended season/episode keys
    /// that review routes receive, resolves here to its owning title. Movies have no season/episode keys.
    /// </summary>
    public static (string Key, int TmdbId)? ParseOwningTitle(string? type, string? key, bool extended = true)
    {
        var kind = type?.ToLowerInvariant() switch { "movie" => "movie", "series" or "tv" => "tv", _ => null };
        if (kind == null || string.IsNullOrEmpty(key)) return null;
        var parts = key.Split(':');
        if (parts.Length > (extended && kind == "tv" ? 3 : 1)
            || !int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var id) || id <= 0
            || parts.Length > 1 && !Ordinal(parts[1], 's') || parts.Length > 2 && !Ordinal(parts[2], 'e')) return null;
        return (kind + ":tmdb:" + id.ToString(CultureInfo.InvariantCulture), id);

        static bool Ordinal(string part, char prefix)
            => part.Length > 1 && part[0] == prefix && int.TryParse(part.AsSpan(1), NumberStyles.None, CultureInfo.InvariantCulture, out _);
    }

    /// <summary>Validates a provider rule key (whole title only, positive Int32 TMDB id).</summary>
    public static string? CanonicalTitle(string? key)
    {
        var title = TitleKey.Parse(key);
        return title is { Provider: "tmdb", Season: null, NumericId: > 0 } ? title.ToString() : null;
    }

    /// <summary>Normalizes both Jellyfin GUID forms without interpreting arbitrary provider keys as IDs.</summary>
    public static string NormalizeId(string? id) => Guid.TryParse(id, out var guid) ? guid.ToString("N") : (id ?? "").ToLowerInvariant();

    /// <summary>Whether this policy contains any rules.</summary>
    public bool IsEmpty => _items.Count + _titles.Count == 0 || !_settings.Enabled;

    /// <summary>The global keys for an existing feed's set-based projection.</summary>
    public HashSet<string> GlobalKeys(string? surface = null)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        if (!_settings.Enabled || !_master || (surface != null && !Filters(surface))) return keys;
        foreach (var map in new[] { _titles, _items })
            foreach (var pair in map) if (pair.Value.Contains("global")) keys.Add(pair.Key);
        return keys;
    }

    /// <summary>All matching uses this method; surfaces are explicit at the feed boundary.</summary>
    public bool IsHidden(string? titleKey, string? itemId, string? seriesId, string surface)
    {
        if (!Filters(surface)) return false;
        return Matches(_titles, titleKey, surface)
            || _libraryKeys.TryGetValue(NormalizeId(itemId), out var ownKey) && Matches(_titles, ownKey, surface)
            || _libraryKeys.TryGetValue(NormalizeId(seriesId), out var parentKey) && Matches(_titles, parentKey, surface) || Matches(_items, NormalizeId(itemId), surface)
            || Matches(_series, NormalizeId(seriesId), surface) || Matches(_series, NormalizeId(itemId), surface);
    }

    /// <summary>Matches a native title DTO, including a typed provider rule after arrival.</summary>
    public bool IsHidden(BaseItemDto item, string surface)
    {
        var tmdb = item.ProviderIds?.FirstOrDefault(p => p.Key.Equals("Tmdb", StringComparison.OrdinalIgnoreCase)).Value;
        return IsHidden(TitleIdentity(item.Type.ToString(), tmdb), item.Id.ToString(), item.SeriesId?.ToString(), surface);
    }

    /// <summary>
    /// Matches a native DTO by its resolved library identity (the item, its owner, the owner's TMDB key); only an item the
    /// identity resolver could not resolve is matched by its own DTO fields.
    /// </summary>
    public bool IsHidden(BaseItemDto item, PrivacyIdentity? identity, string surface)
        => identity != null ? IsHidden(identity, surface) : IsHidden(item, surface);

    /// <summary>Matches a resolved library identity: the item, its owning title by Jellyfin ID, and that title's TMDB key.</summary>
    public bool IsHidden(PrivacyIdentity identity, string surface)
    {
        if (!Filters(surface)) return false;
        var owner = identity.OwnerId != identity.ItemId ? NormalizeId(identity.OwnerId.ToString()) : null;
        return IsHidden(identity.TitleKey, identity.ItemId.ToString(), identity.SeriesId == Guid.Empty ? null : identity.SeriesId.ToString(), surface)
            || owner != null && Matches(_items, owner, surface);
    }

    /// <summary>Resolves missing DTO provider/parent metadata in bounded batches, never per card (the shared identity resolver).</summary>
    public void BindLibraryIds(ILibraryManager library, IEnumerable<Guid> ids)
    {
        if (_titles.Count + _titleItems.Count == 0) return;
        foreach (var identity in PrivacyIdentities.Resolve(library, ids).Values) Bind(identity);
    }

    /// <summary>Binds resolved identities (provider keys of the items and their owners) into this policy.</summary>
    public void Bind(PrivacyIdentity identity)
    {
        if (identity.TitleKey is not { } key) return;
        var id = identity.ItemId.ToString("N");
        _libraryKeys[id] = key;
        var owner = identity.OwnerId.ToString("N");
        if (owner != id) _libraryKeys[owner] = key;
        foreach (var bound in owner == id ? new[] { id } : new[] { id, owner })
            if (_titleItems.TryGetValue(bound, out var scopes)) foreach (var scope in scopes) Add(_titles, key, scope);
    }

    /// <summary>Matches aliases already known by the acquisition index, without any upstream lookup.</summary>
    public bool IsHidden(TitleKey? key, TitleAliases? aliases, string surface)
        => key != null && (IsHidden(key.Title.ToString(), null, null, surface)
            || aliases?.Of(key).Any(alias => IsHidden(alias.Title.ToString(), null, null, surface)) == true);

    private bool Filters(string surface)
    {
        if (!_settings.Enabled || (!_master && !(_remove && surface is "continuewatching" or "nextup"))) return false;
        return surface switch {
            "library" or "details" => _settings.FilterLibrary, "discovery" => _settings.FilterDiscovery,
            "search" => _settings.FilterSearch, "upcoming" => _settings.FilterUpcoming, "calendar" => _settings.FilterCalendar,
            "recommendations" => _settings.FilterRecommendations, "requests" => _settings.FilterRequests,
            "nextup" => _settings.FilterNextUp, "continuewatching" => _settings.FilterContinueWatching, _ => false
        };
    }

    private bool Matches(Dictionary<string, HashSet<string>> map, string? key, string surface)
        => key != null && map.TryGetValue(key, out var scopes) && scopes.Any(s => s == "global" || s == surface
            || s == "homesections" && surface is "nextup" or "continuewatching");

    private static void Add(Dictionary<string, HashSet<string>> map, string key, string scope)
    {
        if (!map.TryGetValue(key, out var scopes)) map[key] = scopes = new(StringComparer.OrdinalIgnoreCase);
        scopes.Add(scope);
    }
}
