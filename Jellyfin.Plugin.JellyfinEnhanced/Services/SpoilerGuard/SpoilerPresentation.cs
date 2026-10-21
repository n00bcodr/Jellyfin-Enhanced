using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>Builds one provider-aware spoiler context for a viewer, after access filtering and before presentation caches.</summary>
public sealed class SpoilerPresentation(UserConfigurationManager config, ILibraryManager library, IUserManager users, IUserDataManager userData)
{
    /// <summary>The watched-state and ownership changes the delivery gate compares (verdict inputs with revisions).</summary>
    private readonly bool _observing = PrivacyInputs.Observe(library, userData);

    /// <summary>The host's user-data store (whose saves the input log compares the watched state it judged with).</summary>
    internal IUserDataManager UserDataStore => userData;

    /// <summary>
    /// The viewer's <see cref="SpoilerPresentationContext.StateRevision"/> as of now: the state file and the admin's settings
    /// only, no library read (the delivery gate's re-read).
    /// </summary>
    public string StateRevision(Guid viewer)
    {
        var plugin = JellyfinEnhanced.Instance?.Configuration ?? new();
        try
        {
            UserSpoilerBlur state;
            lock (config.GetUserFileLock(viewer.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName))
                state = config.GetUserConfigurationStrict<UserSpoilerBlur>(viewer.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, quarantineCorrupt: false);
            return new SpoilerPresentationContext(state, plugin).StateRevision;
        }
        catch (Exception) { return new SpoilerPresentationContext(new(), plugin, unavailable: true).StateRevision; }
    }

    /// <summary>Loads strictly once per request. Unknown policy suppresses sensitive presentation.</summary>
    public SpoilerPresentationContext Load(Guid viewer, HttpContext? http = null)
    {
        var key = "__JE_SPOILER_PRESENTATION_" + viewer.ToString("N");
        if (http?.Items.TryGetValue(key, out var hit) == true && hit is SpoilerPresentationContext cached)
        {
            // The request's context is the state and library facts read earlier: the current attempt records them, as of then.
            if (!cached.Unavailable) config.RecordPolicyRead(viewer.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, cached.State);
            if (PrivacyReadSet.Current is { } reads)
            {
                reads.Since(cached.ReadAt);
                reads.Library(cached.LibraryInputs);
                foreach (var id in cached.LibraryInputs) reads.Watched(viewer, id);
            }
            return cached;
        }
        var readAt = PrivacyInputs.Now;
        var plugin = JellyfinEnhanced.Instance?.Configuration ?? new();
        SpoilerPresentationContext context;
        try
        {
            UserSpoilerBlur state;
            lock (config.GetUserFileLock(viewer.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName))
                state = config.GetUserConfigurationStrict<UserSpoilerBlur>(viewer.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, quarantineCorrupt: false);
            context = new(state, plugin);
            if (plugin.SpoilerBlurEnabled)
            {
                var ids = state.Series.Keys.Concat(state.Movies.Keys).Select(id => Guid.TryParse(id, out var guid) ? guid : Guid.Empty)
                    .Where(id => id != Guid.Empty).Distinct().ToArray();
                var person = users.GetUserById(viewer);
                if (ids.Length > 0 && person != null)
                {
                    foreach (var batch in ids.Chunk(2000))
                    {
                        PrivacyReadSet.Current?.Library(batch);
                        var items = library.GetItemList(new InternalItemsQuery { ItemIds = batch,
                            DtoOptions = new DtoOptions(false) { Fields = new[] { ItemFields.ProviderIds } } });
                        foreach (var item in items)
                        {
                            if (item is not (Movie or Series)) continue;
                            if (PrivacyIdentities.TitleKey(item) is not { } title) continue;
                            var watched = item is Movie && PrivacyReads.UserData(userData, person, item)?.Played == true;
                            context.AddLibraryTitle(title, watched);
                        }
                    }
                }
                // Collection membership is resolved once for the whole context from each guarded BoxSet's linked
                // children (a BoxSet is not its movies' ancestor), never once per result card.
                var collections = state.Collections.Keys.Select(id => Guid.TryParse(id, out var guid) ? guid : Guid.Empty).Where(id => id != Guid.Empty).Distinct().ToArray();
                if (collections.Length > 0 && person != null)
                {
                    var members = collections.SelectMany(c => PrivacyIdentities.CollectionMembers(library, c)).Distinct().ToArray();
                    context.AddCollectionMembers(members);
                    foreach (var batch in members.Chunk(2000))
                    {
                        PrivacyReadSet.Current?.Library(batch);
                        foreach (var item in library.GetItemList(new InternalItemsQuery { ItemIds = batch,
                            DtoOptions = new DtoOptions(false) { Fields = new[] { ItemFields.ProviderIds } } }))
                        {
                            if (item is not Movie || PrivacyIdentities.TitleKey(item) is not { } title) continue;
                            context.AddLibraryTitle(title, PrivacyReads.UserData(userData, person, item)?.Played == true);
                        }
                    }
                }
            }
        }
        catch (Exception) { context = new(new(), plugin, unavailable: true); }
        context.ReadAt = readAt;
        context.Seal();
        if (http != null) http.Items[key] = context;
        return context;
    }

    /// <summary>
    /// The shared identity resolver with this viewer's watched state and guarded collections: what every row that names a
    /// library item (activity, recommendation seeds) is judged by.
    /// </summary>
    public Dictionary<Guid, PrivacyIdentity> Resolve(IEnumerable<Guid> ids, Guid viewer, SpoilerPresentationContext? context)
    {
        var person = viewer == Guid.Empty ? null : users.GetUserById(viewer);
        var collections = context?.State.Collections.Keys.Select(id => Guid.TryParse(id, out var guid) ? guid : Guid.Empty) ?? [];
        return PrivacyIdentities.Resolve(library, ids, person, userData, collections);
    }
}

/// <summary>Effective strip decisions shared by JSON feeds, missing rows, native pages, metadata and art.</summary>
public sealed class SpoilerPresentationContext
{
    private readonly HashSet<string> _titles = new(StringComparer.Ordinal);
    private readonly HashSet<string> _watched = new(StringComparer.Ordinal);
    private readonly PluginConfiguration _config;
    private readonly bool _unavailable;
    internal bool Unavailable => _unavailable;

    /// <summary>The input tick the context's library facts were read at.</summary>
    internal long ReadAt { get; set; }
    internal bool Enabled => _config.SpoilerBlurEnabled;

    /// <summary>The viewer's state; callers pass it to the existing native DTO stripper.</summary>
    public UserSpoilerBlur State { get; }

    /// <summary>A fingerprint of the full viewer and admin spoiler policy, stable across restarts.</summary>
    public string Revision { get; private set; }

    /// <summary>
    /// The fingerprint of what the viewer's state file and the admin's settings say, before the library facts the context
    /// adds (its guarded titles' keys, their watched state, collections' members): what the delivery gate re-reads, the
    /// library facts being inputs it compares by their own revisions (<see cref="LibraryInputs"/>).
    /// </summary>
    public string StateRevision { get; }

    /// <summary>The library items whose facts this context read: the guarded titles and collections, and the collections' members.</summary>
    internal IEnumerable<Guid> LibraryInputs => State.Series.Keys.Concat(State.Movies.Keys).Concat(State.Collections.Keys)
        .Select(id => Guid.TryParse(id, out var guid) ? guid : Guid.Empty).Where(id => id != Guid.Empty).Concat(_members);

    /// <summary>Creates a context; no shared upstream objects are modified.</summary>
    public SpoilerPresentationContext(UserSpoilerBlur state, PluginConfiguration config, bool unavailable = false)
    {
        // Every privacy setting (strip, advanced and next-episode settings included) is part of both revisions.
        var settings = PrivacySettings.Revision(config);
        State = Newtonsoft.Json.JsonConvert.DeserializeObject<UserSpoilerBlur>(Newtonsoft.Json.JsonConvert.SerializeObject(state))!;
        _config = new PluginConfiguration { SpoilerBlurEnabled = config.SpoilerBlurEnabled, SpoilerBlurArtwork = config.SpoilerBlurArtwork,
            SpoilerKeepMoviePosters = config.SpoilerKeepMoviePosters, SpoilerBlurIntensity = config.SpoilerBlurIntensity, SpoilerBlurMode = config.SpoilerBlurMode,
            SpoilerStripOverview = config.SpoilerStripOverview, SpoilerStripSeriesOverview = config.SpoilerStripSeriesOverview,
            SpoilerStripRatings = config.SpoilerStripRatings, SpoilerStripCast = config.SpoilerStripCast, SpoilerStripTags = config.SpoilerStripTags,
            SpoilerStripCastMode = config.SpoilerStripCastMode,
            SpoilerStripPremiereDate = config.SpoilerStripPremiereDate, SpoilerStripTaglines = config.SpoilerStripTaglines,
            SpoilerStripReviews = config.SpoilerStripReviews, SpoilerReplaceTitle = config.SpoilerReplaceTitle };
        state = State; config = _config; _unavailable = unavailable;
        foreach (var key in state.PendingTmdb.Keys)
        {
            var parts = key.Split(':');
            if (parts.Length == 2 && HiddenContentPolicy.TitleIdentity(parts[0], parts[1]) is { } title) _titles.Add(title);
        }
        foreach (var key in state.ProviderTitles.Keys) if (HiddenContentPolicy.CanonicalTitle(key) is { } title) _titles.Add(title);
        // No lists or names go into the public revision, only a one-way policy fingerprint.
        Revision = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Newtonsoft.Json.JsonConvert.SerializeObject(new {
            state, config.SpoilerBlurEnabled, config.SpoilerBlurArtwork, config.SpoilerKeepMoviePosters, config.SpoilerBlurIntensity,
            config.SpoilerBlurMode, config.SpoilerStripOverview, config.SpoilerStripSeriesOverview, config.SpoilerStripRatings,
            config.SpoilerStripCast, config.SpoilerStripCastMode, config.SpoilerStripTags, config.SpoilerStripPremiereDate, config.SpoilerStripTaglines,
            config.SpoilerStripReviews, config.SpoilerReplaceTitle, unavailable, settings
        }))));
        StateRevision = Revision;
    }

    internal void Seal() => Revision = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Revision + "|" + string.Join(',', _titles.OrderBy(k => k, StringComparer.Ordinal)) + "|" + string.Join(',', _watched.OrderBy(k => k, StringComparer.Ordinal)))));

    internal void AddLibraryTitle(string key, bool watched) { if (watched) _watched.Add(key); else _titles.Add(key); }

    private readonly HashSet<Guid> _members = new();
    private readonly Dictionary<string, bool> _identities = new(StringComparer.Ordinal);

    internal void AddCollectionMembers(IEnumerable<Guid> members) => _members.UnionWith(members);

    /// <summary>
    /// The native rule set for a library identity: Jellyfin ID (the item or its owning series), a guarded collection that
    /// links the movie, durable provider intent, and the viewer's watched state (a watched movie or episode is not guarded).
    /// </summary>
    public bool Guarded(PrivacyIdentity identity)
    {
        if (!_config.SpoilerBlurEnabled) return false;
        if (_unavailable) return true;
        if (identity.Played == true) return false;
        static string N(Guid id) => id.ToString("N");
        var key = identity.TitleKey;
        var provider = key != null && (State.ProviderTitles.ContainsKey(key) || State.PendingTmdb.ContainsKey(key.Replace(":tmdb:", ":", StringComparison.Ordinal)));
        return identity.Kind switch
        {
            BaseItemKind.Movie => State.Movies.ContainsKey(N(identity.ItemId)) || provider || _members.Contains(identity.ItemId)
                || identity.Collections.Any(c => State.Collections.ContainsKey(N(c))),
            BaseItemKind.Series or BaseItemKind.Season or BaseItemKind.Episode => State.Series.ContainsKey(N(identity.OwnerId)) || provider,
            // Extras follow their owning title (a movie's extras also its guarded collections).
            _ => identity.IsExtra && (State.Series.ContainsKey(N(identity.OwnerId)) || State.Movies.ContainsKey(N(identity.OwnerId)) || provider
                || _members.Contains(identity.OwnerId) || identity.Collections.Any(c => State.Collections.ContainsKey(N(c))))
        };
    }

    /// <summary>
    /// Binds a library identity to a projection key, so a row about that item is projected by the one schema projection
    /// exactly as its TMDB key would be, but with the item's own native decision (Jellyfin-ID rules, watched state).
    /// </summary>
    public string Bind(PrivacyIdentity identity)
    {
        var key = identity.ProjectionKey;
        _identities[key] = Guarded(identity);
        return key;
    }

    internal bool KnowsTitle(string? title) => title != null && (_titles.Contains(title) || _watched.Contains(title));

    /// <summary>Each result is judged by its own typed identity, never by the seed's guard.</summary>
    public bool Guarded(string? title) => _config.SpoilerBlurEnabled && (_unavailable || title != null
        && (_identities.TryGetValue(title, out var bound) ? bound : _titles.Contains(title) && !_watched.Contains(title)));

    /// <summary>Existing admin caps and per-user opt-outs, including the separate series-description policy.</summary>
    public (bool Title, bool Overview, bool AirDate) MissingRow(string? title)
        => Guarded(title) ? SpoilerFieldStripFilter.AbsentRowStrip(State, _config) : (false, false, false);

    /// <summary>Ratings/reviews/date decorators use the same effective cap and preference decisions.</summary>
    public bool HidesRatings(string? title) => Guarded(title) && Strip(_config.SpoilerStripRatings, State.Prefs?.HideRatings);
    public bool HidesReviews(string? title) => Guarded(title) && Strip(_config.SpoilerStripReviews, State.Prefs?.HideReviews);
    public bool HidesDates(string? title) => Guarded(title) && Strip(_config.SpoilerStripPremiereDate, State.Prefs?.HideAirDate);

    /// <summary>Flags for clients and record-based feeds; contains no private rule lists.</summary>
    public JsonObject Flags(string title)
    {
        var row = new JsonObject();
        ProjectTitle(row, title, title.StartsWith("movie:", StringComparison.Ordinal) ? "movie" : "tv");
        return (JsonObject)row["jeSpoiler"]!.DeepClone();
    }

    /// <summary>Known provider subresources have distinct schemas and must not bypass the title strip.</summary>
    public string ProjectResource(string json, string? title, string resource, string? fallbackKind = null, string? scopeKind = null, int season = 0, int episode = 0)
        => !_config.SpoilerBlurEnabled ? json : ProviderPresentationSchema.Project(json, null, this, "discovery", title, resource, fallbackKind, scopeKind, season, episode);

    /// <summary>Whether original artwork is protected. Movie posters follow the existing keep-posters option.</summary>
    public bool ProtectArtwork(string? title, string kind, string imageType, int season = 0)
    {
        if (!Guarded(title)) return false;
        return kind == "episode" && imageType is "Primary" or "Thumb" or "Screenshot"
            || kind == "season" && season > 1 && imageType == "Primary"
            || kind == "movie" && !_config.SpoilerKeepMoviePosters && imageType is "Primary" or "Thumb"
            || _config.SpoilerBlurArtwork && imageType is "Backdrop" or "Art" or "Logo";
    }

    /// <summary>Projects one title/card, its nested season/episode fields and safe effective flags.</summary>
    public void ProjectTitle(JsonObject row, string title, string kind, int season = 0, int episode = 0)
    {
        if (!_config.SpoilerBlurEnabled) { AddNavigationMetadata(row, title, kind, season, episode); return; }
        var projected = JsonNode.Parse(ProviderPresentationSchema.Project(row.ToJsonString(), null, this, "discovery", title, kind is "episode" or "season" ? kind : "title", kind, kind, season, episode))!.AsObject();
        row.Clear();
        foreach (var pair in projected.ToArray()) row[pair.Key] = pair.Value?.DeepClone();
    }

    internal void AddNavigationMetadata(JsonObject row, string title, string kind, int season, int episode)
    {
        // The year is navigation metadata; precise release/air dates still follow the strip policy.
        if (kind is "movie" or "tv" && row["year"] == null)
        {
            var date = (row["releaseDate"] ?? row["release_date"] ?? row["firstAirDate"] ?? row["first_air_date"])?.ToString();
            if (date?.Length >= 4 && int.TryParse(date.AsSpan(0, 4), out var year) && year is >= 1800 and <= 9999) row["year"] = year;
        }
        // Age certification is safe, independently of the precise dates in the release resource.
        if (kind == "movie" && row["contentRatings"] == null && row["releases"]?["results"] is JsonArray releases)
        {
            var certifications = new JsonArray();
            foreach (var release in releases.OfType<JsonObject>())
                if (release["release_dates"] is JsonArray releaseDates)
                {
                    var certification = releaseDates.OfType<JsonObject>().Select(d => d["certification"]).OfType<JsonValue>()
                        .Select(value => value.TryGetValue<string>(out var label) ? label : null).FirstOrDefault(label => !string.IsNullOrWhiteSpace(label));
                    if (certification != null) certifications.Add(new JsonObject { ["iso_3166_1"] = release["iso_3166_1"]?.DeepClone(), ["rating"] = certification });
                }
            row["contentRatings"] = new JsonObject { ["results"] = certifications };
        }
        var guarded = Guarded(title);
        var exempt = kind == "season" && season <= 1;
        var prefs = State.Prefs;
        var overview = guarded && !exempt && Strip(kind == "tv" ? (_config.SpoilerStripSeriesOverview ?? _config.SpoilerStripOverview) : _config.SpoilerStripOverview,
            kind == "tv" ? prefs?.HideSeriesDescriptions : prefs?.HideEpisodeDescriptions);
        var ratings = guarded && !exempt && Strip(_config.SpoilerStripRatings, prefs?.HideRatings);
        var dates = guarded && !exempt && Strip(_config.SpoilerStripPremiereDate, prefs?.HideAirDate);
        var cast = guarded && !exempt && Strip(_config.SpoilerStripCast, prefs?.HideCast);
        var tags = guarded && !exempt && Strip(_config.SpoilerStripTags, prefs?.HideTags);
        var reviews = guarded && !exempt && Strip(_config.SpoilerStripReviews, prefs?.HideReviews);
        var allCast = cast && string.Equals(_config.SpoilerStripCastMode, "All", StringComparison.OrdinalIgnoreCase);
        var flags = row["jeSpoiler"] as JsonObject ?? new();
        flags["guarded"] = guarded; flags["overview"] = overview; flags["ratings"] = ratings;
        flags["dates"] = dates; flags["cast"] = allCast; flags["tags"] = tags; flags["reviews"] = reviews; flags["revision"] = Revision;
        row["jeSpoiler"] = flags;
    }

    internal bool Suppresses(string? title, string policy, string kind, int season)
    {
        if (!Guarded(title) || kind == "season" && season <= 1) return false;
        return policy switch {
            "taglines" => Strip(_config.SpoilerStripTaglines, State.Prefs?.HideTaglines),
            "ratings" => Strip(_config.SpoilerStripRatings, State.Prefs?.HideRatings),
            "dates" => Strip(_config.SpoilerStripPremiereDate, State.Prefs?.HideAirDate),
            "reviews" => Strip(_config.SpoilerStripReviews, State.Prefs?.HideReviews),
            "tags" => Strip(_config.SpoilerStripTags, State.Prefs?.HideTags),
            "cast" => Strip(_config.SpoilerStripCast, State.Prefs?.HideCast),
            "all-cast" => Strip(_config.SpoilerStripCast, State.Prefs?.HideCast) && string.Equals(_config.SpoilerStripCastMode, "All", StringComparison.OrdinalIgnoreCase),
            "plot" => Strip(_config.SpoilerStripOverview, State.Prefs?.HideEpisodeDescriptions),
            "overview" => Strip(kind == "tv" ? _config.SpoilerStripSeriesOverview ?? _config.SpoilerStripOverview : _config.SpoilerStripOverview,
                kind == "tv" ? State.Prefs?.HideSeriesDescriptions : State.Prefs?.HideEpisodeDescriptions),
            _ => false
        };
    }

    private static bool Strip(bool admin, bool? preference) => admin && preference != false;
}
