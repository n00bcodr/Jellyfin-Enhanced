using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// The effective Spoiler Guard tag-strip policy for one user: the admin strip toggles with the user's
    /// per-category opt-outs applied ("user opt-out wins", null override = inherit admin = strip).
    /// </summary>
    public sealed class SpoilerTagStripPolicy
    {
        internal SpoilerTagStripPolicy(UserSpoilerBlur state, bool stripGenres, bool stripRatings, bool replaceTitle, bool stripOverview)
        {
            State = state;
            StripGenres = stripGenres;
            StripRatings = stripRatings;
            ReplaceTitle = replaceTitle;
            StripOverview = stripOverview;
        }

        /// <summary>The user's spoiler state the policy was built from (non-empty).</summary>
        public UserSpoilerBlur State { get; }

        /// <summary>Strip genres, languages and stream data (SpoilerStripTags).</summary>
        public bool StripGenres { get; }

        /// <summary>Strip community/critic ratings and an Episode/Season's own age rating (SpoilerStripRatings).</summary>
        public bool StripRatings { get; }

        /// <summary>Episode titles are replaced (SpoilerReplaceTitle).</summary>
        public bool ReplaceTitle { get; }

        /// <summary>Descriptions are stripped (SpoilerStripOverview).</summary>
        public bool StripOverview { get; }

        /// <summary>Title-bearing stream fields must be sanitized.</summary>
        public bool SanitizeTitleStreams => ReplaceTitle || StripOverview;
    }

    /// <summary>Which Spoiler Guard stub POST /tag-data returns for an item.</summary>
    public enum SpoilerTagDataStub
    {
        /// <summary>No stub: the item gets its regular projection.</summary>
        None,

        /// <summary>Unwatched episode of a guarded series.</summary>
        Episode,

        /// <summary>A guarded series.</summary>
        Series,

        /// <summary>Unwatched movie in spoiler scope (directly or via an opted-in collection).</summary>
        Movie,

        /// <summary>A season after S1 of a guarded series with no watched episode.</summary>
        Season,
    }

    // Spoiler Guard's stripping of JE tag data, shared by GET /tag-cache, POST
    // /tag-data (JellyfinEnhancedController) and native poster tags (so a
    // poster baked for a guarded item shows exactly what the web overlays
    // would: nothing that the web hides). Extracted verbatim from the
    // controller; the decisions mirror SpoilerBlurImageFilter and
    // SpoilerFieldStripFilter (played episodes/movies pass, S0/S1 seasons and
    // seasons with any watched episode are exempt, collections pass).
    //
    // TagCacheService stores ONE shared TagCacheEntry per item across ALL
    // users: every strip clones, never mutates.
    public sealed class SpoilerTagDataStripper
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IUserDataManager _userDataManager;
        private readonly SpoilerUserResolver _spoilerResolver;

        public SpoilerTagDataStripper(ILibraryManager libraryManager, IUserDataManager userDataManager, SpoilerUserResolver spoilerResolver)
        {
            _libraryManager = libraryManager;
            _userDataManager = userDataManager;
            _spoilerResolver = spoilerResolver;
        }

        /// <summary>
        /// True when Spoiler Guard is on with at least one tag-relevant strip toggle, i.e. when the endpoints
        /// load the user's spoiler state at all. Each overlay has its own admin toggle; title replacement or
        /// overview strip alone must also trigger the strip so stream titles can't leak episode titles.
        /// </summary>
        public static bool IsConfigured(PluginConfiguration? cfg)
            => cfg?.SpoilerBlurEnabled == true
                && (cfg.SpoilerStripTags || cfg.SpoilerStripRatings || cfg.SpoilerReplaceTitle || cfg.SpoilerStripOverview);

        /// <summary>
        /// The effective policy for a user, or null when nothing is stripped: Spoiler Guard off, no strip
        /// toggle, no spoiler state or an empty one (all three of Series/Movies/Collections), or the user
        /// opted out of every category the admin enabled.
        /// </summary>
        public static SpoilerTagStripPolicy? CreatePolicy(PluginConfiguration? cfg, UserSpoilerBlur? state)
        {
            if (!IsConfigured(cfg)) return null;
            // Empty lists = nothing to strip; check all three dicts, not just
            // Series.Count, so a movies-only user isn't short-circuited.
            if (state == null || (state.Series.Count == 0 && state.Movies.Count == 0 && state.Collections.Count == 0))
            {
                return null;
            }

            var prefs = state.Prefs;
            var stripGenres = cfg!.SpoilerStripTags && (prefs?.HideTags ?? true);
            var stripRatings = cfg.SpoilerStripRatings && (prefs?.HideRatings ?? true);
            var replaceTitle = cfg.SpoilerReplaceTitle && (prefs?.ReplaceEpisodeTitles ?? true);
            var stripOverview = cfg.SpoilerStripOverview && (prefs?.HideEpisodeDescriptions ?? true);
            // The user opted out of everything the admin enabled: nothing to do.
            if (!(stripGenres || stripRatings || replaceTitle || stripOverview)) return null;
            return new SpoilerTagStripPolicy(state, stripGenres, stripRatings, replaceTitle, stripOverview);
        }

        /// <summary>
        /// Which guarded kind (Episode/Season/Movie/Series) a tag-cache entry is under this user's Spoiler
        /// Guard, or null when it isn't guarded. <paramref name="key"/> is the item id in N format.
        /// </summary>
        public string? GetGuardedKind(UserSpoilerBlur state, string key, TagCacheEntry? e)
        {
            if (e == null) return null;
            switch (e.Type)
            {
                case "Movie":
                    // In scope if directly in Movies dict OR a child of an opted-in collection.
                    return Guid.TryParse(key, out var mGuid) && _spoilerResolver.IsMovieInSpoilerScope(state, mGuid) ? "Movie" : null;
                case "Series":
                    // Series-level entry: strip only when Spoiler Guard is on for
                    // THIS series (key == series ID). Covers home-rail cards bound
                    // to seriesId when "Use episode images in Next Up/Continue Watching"
                    // is OFF, so cards use series posters and ask for series-level tag data.
                    return state.Series.ContainsKey(key) ? "Series" : null;
                case "Episode":
                case "Season":
                    return !string.IsNullOrEmpty(e.SeriesId) && state.Series.ContainsKey(e.SeriesId) ? e.Type : null;
                default:
                    return null;
            }
        }

        /// <summary>
        /// Whether an image owner known only by id, type and (for Episode/Season) series id is under this
        /// user's Spoiler Guard: the <see cref="GetGuardedKind"/> rule on a probe entry, regardless of played
        /// state, season exemptions or strip toggles (native poster tags: token minting and image caching).
        /// </summary>
        public bool IsGuarded(UserSpoilerBlur state, Guid ownerId, string ownerType, string? ownerSeriesIdN)
        {
            if (state.Series.Count == 0 && state.Movies.Count == 0 && state.Collections.Count == 0) return false;
            var probe = new TagCacheEntry { Type = ownerType, SeriesId = ownerSeriesIdN };
            return GetGuardedKind(state, ownerId.ToString("N"), probe) != null;
        }

        /// <summary>
        /// GET /tag-cache strip: replaces every guarded, not-exempt entry of <paramref name="items"/> with a
        /// stripped clone. Played state is looked up in ONE bounded query instead of a UserData read per entry.
        /// Returns a fingerprint of the effective strip flags and the set of guarded entries (the client replaces
        /// its stored copy, rather than applying a delta, when it changes).
        /// </summary>
        public string StripTagCache(SpoilerTagStripPolicy policy, JUser user, Dictionary<string, TagCacheEntry> items)
        {
            var spState = policy.State;
            var stripRatingsEnabled = policy.StripRatings;
            // Series age rating per guarded series, looked up once per request.
            var ageSeriesRatingMemo = new Dictionary<Guid, string?>();

            // Played state is looked up in ONE bounded query instead of a
            // UserData read per entry (with whole libraries guarded that
            // was thousands of reads and seconds per cache load): collect
            // the guarded episodes/movies, plus the episodes of guarded
            // later seasons (S2+, same membership rules as the image and
            // field filters via Season.GetEpisodes), then ask which of
            // them this user has played.
            var playedCandidates = new List<Guid>();
            var laterSeasons = new List<Season>();
            // Kind per guarded key, reused by the strip pass so both
            // passes see the same answer.
            var guardedKinds = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var kvp in items)
            {
                var kind = GetGuardedKind(spState, kvp.Key, kvp.Value);
                if (kind == null) continue;
                guardedKinds[kvp.Key] = kind;
                if (!Guid.TryParse(kvp.Key, out var cGuid)) continue;
                if (kind is "Episode" or "Movie")
                {
                    playedCandidates.Add(cGuid);
                }
                else if (kind == "Season"
                    && _libraryManager.GetItemById<BaseItem>(cGuid) is Season laterSeason
                    && laterSeason.IndexNumber.GetValueOrDefault(int.MaxValue) > 1)
                {
                    laterSeasons.Add(laterSeason);
                }
            }

            // Season.GetEpisodes is a query per season. A full load can
            // carry hundreds of guarded later seasons, so first find which
            // shows the user has played anything of (by series id and by
            // series presentation key, which GetEpisodes matches on) and
            // skip seasons of untouched shows: they can't contain a
            // watched episode.
            var playedSeries = laterSeasons.Count > 16 ? LoadPlayedSeriesForTagStrip(user) : null;
            var laterSeasonEpisodes = new Dictionary<Guid, List<Guid>?>();
            foreach (var laterSeason in laterSeasons)
            {
                if (playedSeries != null
                    && !playedSeries.Value.Ids.Contains(laterSeason.SeriesId)
                    && (string.IsNullOrEmpty(laterSeason.SeriesPresentationUniqueKey) || !playedSeries.Value.Keys.Contains(laterSeason.SeriesPresentationUniqueKey))
                    && (laterSeason.Series?.PresentationUniqueKey is not { Length: > 0 } currentKey || !playedSeries.Value.Keys.Contains(currentKey)))
                {
                    laterSeasonEpisodes[laterSeason.Id] = null;
                    continue;
                }
                List<Guid>? episodeIds = null;
                try
                {
                    episodeIds = laterSeason.GetEpisodes(user, new MediaBrowser.Controller.Dto.DtoOptions(false), shouldIncludeMissingEpisodes: false)
                        .Where(ep => ep != null)
                        .Select(ep => ep.Id)
                        .ToList();
                    playedCandidates.AddRange(episodeIds);
                }
                catch (Exception ex)
                {
                    _spoilerResolver.WarnRateLimited(
                        "tagcache-season-probe:" + ex.GetType().FullName,
                        $"Spoiler Guard tag-cache strip: season any-watched probe failed for {laterSeason.Id}: {ex.Message}");
                    // Fail-CLOSED: null = treated as not watched, stripped.
                }
                laterSeasonEpisodes[laterSeason.Id] = episodeIds;
            }
            var playedIds = LoadPlayedIdsForTagStrip(user, playedCandidates);

            var revisionKeys = guardedKinds.Keys.ToList();
            revisionKeys.Sort(StringComparer.Ordinal);
            var fingerprint = $"g{(policy.StripGenres ? 1 : 0)}r{(policy.StripRatings ? 1 : 0)}t{(policy.SanitizeTitleStreams ? 1 : 0)}|{string.Join(',', revisionKeys)}";

            foreach (var kvp in items.ToList())
            {
                var entry = kvp.Value;
                if (!guardedKinds.TryGetValue(kvp.Key, out var kind)) continue;
                var isEpisode = kind == "Episode";
                var isSeason = kind == "Season";
                var isMovie = kind == "Movie";

                // Episodes/movies: played skips the strip. Seasons: IndexNumber<=1
                // OR any-episode-watched skips (mirrors SpoilerBlurImageFilter and
                // SpoilerFieldStripFilter Season blur logic).
                if (Guid.TryParse(kvp.Key, out var entryGuid))
                {
                    if (isEpisode || isMovie)
                    {
                        if (playedIds.Contains(entryGuid)) continue;
                    }
                    else if (isSeason
                        && _libraryManager.GetItemById<BaseItem>(entryGuid) is Season seasonItem)
                    {
                        var sNum = seasonItem.IndexNumber.GetValueOrDefault(int.MaxValue);
                        // S0/S1 posters always pass (their existence isn't a
                        // spoiler), as do seasons with any watched episode — "exempt".
                        bool seasonExempt = sNum <= 1
                            || (laterSeasonEpisodes.TryGetValue(seasonItem.Id, out var seasonEpisodeIds)
                                && seasonEpisodeIds != null
                                && seasonEpisodeIds.Exists(playedIds.Contains));
                        if (seasonExempt)
                        {
                            if (StripExemptSeasonRating(entry, stripRatingsEnabled) is { } seasonStripped)
                            {
                                items[kvp.Key] = seasonStripped;
                            }
                            continue;
                        }
                    }
                }
                else
                {
                    // Rate-limited warn so a future TagCacheService key-format
                    // change is observable rather than silently stripping every rail.
                    _spoilerResolver.WarnRateLimited(
                        "tagcache-key-not-guid",
                        $"Spoiler Guard tag-cache strip: TagCacheService key '{kvp.Key}' did not parse as Guid; played-state check skipped. Possible cache-key format change.");
                }

                items[kvp.Key] = StripEntryFields(entry, kind, policy, ageSeriesRatingMemo);
            }

            return fingerprint;
        }

        /// <summary>
        /// The same strip as <see cref="StripTagCache"/> for ONE entry (native poster tags). Returns the
        /// shared entry unchanged when nothing applies, else a stripped clone, with
        /// <paramref name="stripped"/> telling which.
        /// </summary>
        public TagCacheEntry StripEntry(SpoilerTagStripPolicy policy, JUser user, BaseItem item, TagCacheEntry entry, out bool stripped)
        {
            stripped = false;
            var key = item.Id.ToString("N");
            var kind = GetGuardedKind(policy.State, key, entry);
            if (kind == null) return entry;

            if (kind is "Episode" or "Movie")
            {
                // Same rule as the bulk IsPlayed query: played passes.
                bool played;
                try
                {
                    played = _userDataManager.GetUserData(user, item)?.Played == true;
                }
                catch (Exception ex)
                {
                    _spoilerResolver.WarnRateLimited(
                        "postertags-played-probe:" + ex.GetType().FullName,
                        $"Spoiler Guard tag strip (native poster tags): played-state lookup failed for {item.Id}: {ex.Message}");
                    played = false; // fail-closed: strip
                }

                if (played) return entry;
            }
            else if (kind == "Season" && _libraryManager.GetItemById<BaseItem>(item.Id) is Season season)
            {
                var sNum = season.IndexNumber.GetValueOrDefault(int.MaxValue);
                if (sNum <= 1 || HasWatchedAnyEpisode(season, user, "postertags-season-probe:"))
                {
                    var seasonStripped = StripExemptSeasonRating(entry, policy.StripRatings);
                    if (seasonStripped == null) return entry;
                    stripped = true;
                    return seasonStripped;
                }
            }

            stripped = true;
            return StripEntryFields(entry, kind, policy, new Dictionary<Guid, string?>());
        }

        /// <summary>
        /// POST /tag-data: which Spoiler Guard stub (if any) replaces this item's regular projection.
        /// </summary>
        public SpoilerTagDataStub GetTagDataStub(SpoilerTagStripPolicy policy, JUser user, BaseItem item)
        {
            var spoilerState = policy.State;

            // Unwatched Episode of a guarded series.
            if (item is Episode spEp
                && spEp.SeriesId != Guid.Empty
                && spoilerState.Series.ContainsKey(spEp.SeriesId.ToString("N")))
            {
                var spUd = _userDataManager.GetUserData(user, spEp);
                return spUd?.Played != true ? SpoilerTagDataStub.Episode : SpoilerTagDataStub.None;
            }

            // A Series the user has Spoiler Guard on. Covers home-rail cards bound
            // to seriesId — e.g. NextUp / Continue Watching with "Use episode
            // images" OFF, where cards show the series poster.
            if (item is Series spSeries
                && spoilerState.Series.ContainsKey(spSeries.Id.ToString("N")))
            {
                return SpoilerTagDataStub.Series;
            }

            // Unwatched Movie in the user's spoiler scope.
            if (item is Movie spMovie
                && _spoilerResolver.IsMovieInSpoilerScope(spoilerState, spMovie.Id))
            {
                var spMovieUd = _userDataManager.GetUserData(user, spMovie);
                return spMovieUd?.Played != true ? SpoilerTagDataStub.Movie : SpoilerTagDataStub.None;
            }

            // BoxSet (Collection) DTOs pass through unstripped: the collection's own
            // art is the entry point the user just clicked (like Series), so blurring
            // it would spoil their own navigation. Movies inside opted-in collections
            // are already handled by the Movie stub via IsMovieInSpoilerScope.

            // Season of a guarded series with no watched episode and not S0/S1.
            // Mirrors the field-strip filter's Season strip + the image filter's
            // HasWatchedAnyEpisodeInSeason gate.
            if (item is Season spSeason
                && spSeason.SeriesId != Guid.Empty
                && spoilerState.Series.ContainsKey(spSeason.SeriesId.ToString("N")))
            {
                var sNum = spSeason.IndexNumber.GetValueOrDefault(int.MaxValue);
                if (sNum > 1 && !HasWatchedAnyEpisode(spSeason, user, "tagdata-season-probe:"))
                {
                    return SpoilerTagDataStub.Season;
                }
            }

            return SpoilerTagDataStub.None;
        }

        // Exempt seasons keep their poster + non-rating tags, but a season
        // carries only the series-FALLBACK rating (hidden on the guarded series
        // everywhere else). Strip just the rating so it can't surface via the
        // server tag cache. Null when there is nothing to strip.
        private static TagCacheEntry? StripExemptSeasonRating(TagCacheEntry entry, bool stripRatingsEnabled)
        {
            if (!stripRatingsEnabled || (entry.CommunityRating == null && entry.CriticRating == null)) return null;
            var seasonStripped = entry.Clone();
            seasonStripped.CommunityRating = null;
            seasonStripped.CriticRating = null;
            return seasonStripped;
        }

        // TagCacheService stores ONE shared TagCacheEntry per item across
        // ALL users. Mutating in place would leak this user's strip into
        // every other user's cache response (and their own later watched
        // response, until rebuild). Clone before mutating.
        private TagCacheEntry StripEntryFields(TagCacheEntry entry, string kind, SpoilerTagStripPolicy policy, Dictionary<Guid, string?> ageSeriesRatingMemo)
        {
            var isEpisode = kind == "Episode";
            var isSeason = kind == "Season";
            var stripGenresEnabled = policy.StripGenres;
            var stripRatingsEnabled = policy.StripRatings;
            var sanitizeTitleStreams = policy.SanitizeTitleStreams;

            var stripped = entry.Clone();
            if (stripGenresEnabled)
            {
                stripped.Genres = System.Array.Empty<string>();
                stripped.AudioLanguages = null;
                stripped.PartialAudioLanguages = null;
                stripped.StreamData = null;
            }
            if (stripRatingsEnabled)
            {
                stripped.CommunityRating = null;
                stripped.CriticRating = null;
                // Age rating: keep the series-level one (not a spoiler) but
                // drop an Episode/Season's own, which can differ from the
                // series and Jellyfin never shows. Mirrors GetTagData's stubs.
                if ((isEpisode || isSeason) && Guid.TryParse(entry.SeriesId, out var ageSeriesGuid))
                {
                    if (!ageSeriesRatingMemo.TryGetValue(ageSeriesGuid, out var ageSeriesRating))
                    {
                        ageSeriesRating = _libraryManager.GetItemById<BaseItem>(ageSeriesGuid)?.OfficialRating;
                        ageSeriesRating = string.IsNullOrWhiteSpace(ageSeriesRating) ? null : ageSeriesRating;
                        ageSeriesRatingMemo[ageSeriesGuid] = ageSeriesRating;
                    }
                    stripped.OfficialRating = ageSeriesRating;
                }
            }
            // When StreamData wasn't already wiped by tag-strip but title
            // replacement / overview strip is on, sanitize its title-bearing
            // fields. Clone StreamData (same cross-user-mutation hazard).
            // qualitytags.js recomputes overlay text from Codec/Height/
            // VideoRangeType, so dropping DisplayTitle/ItemName/paths is acceptable.
            if (sanitizeTitleStreams && stripped.StreamData != null && !stripGenresEnabled)
            {
                var sd = stripped.StreamData;
                var clonedSd = new TagStreamData
                {
                    ItemName = null,
                    ItemPath = null,
                    Streams = sd.Streams?.Select(st => new TagMediaStream
                    {
                        Type = st.Type,
                        Language = st.Language,
                        Codec = st.Codec,
                        CodecTag = st.CodecTag,
                        Profile = st.Profile,
                        Height = st.Height,
                        Channels = st.Channels,
                        ChannelLayout = st.ChannelLayout,
                        VideoRangeType = st.VideoRangeType,
                        DisplayTitle = null,
                    }).ToList(),
                    Sources = sd.Sources?.Select(_ => new TagMediaSource
                    {
                        Path = null,
                        Name = null,
                    }).ToList(),
                };
                stripped.StreamData = clonedSd;
            }
            return stripped;
        }

        // Fail-CLOSED: a failed probe counts as "nothing watched", so the
        // season stays stripped.
        private bool HasWatchedAnyEpisode(Season season, JUser user, string warnKeyPrefix)
        {
            try
            {
                foreach (var ep in season.GetEpisodes(user, new MediaBrowser.Controller.Dto.DtoOptions(false), shouldIncludeMissingEpisodes: false))
                {
                    if (ep == null) continue;
                    var ud = _userDataManager.GetUserData(user, ep);
                    if (ud?.Played == true) return true;
                }
            }
            catch (Exception ex)
            {
                var label = warnKeyPrefix.StartsWith("tagdata", StringComparison.Ordinal)
                    ? "Spoiler Guard tag-data"
                    : "Spoiler Guard tag strip (native poster tags)";
                _spoilerResolver.WarnRateLimited(
                    warnKeyPrefix + ex.GetType().FullName,
                    $"{label}: season any-watched probe failed for {season.Id}: {ex.Message}");
            }

            return false;
        }

        /// <summary>
        /// Which of <paramref name="candidateIds"/> <paramref name="user"/> has
        /// played, from one id-only query (tag-cache Spoiler Guard strip).
        /// Fail-closed: on error nothing counts as played, so every guarded
        /// entry is stripped.
        /// </summary>
        private HashSet<Guid> LoadPlayedIdsForTagStrip(JUser user, List<Guid> candidateIds)
        {
            var played = new HashSet<Guid>();
            if (candidateIds.Count == 0) return played;
            try
            {
                foreach (var id in _libraryManager.GetItemIds(new InternalItemsQuery(user)
                {
                    ItemIds = candidateIds.Distinct().ToArray(),
                    IsPlayed = true,
                    GroupByPresentationUniqueKey = false,
                }))
                {
                    played.Add(id);
                }
            }
            catch (Exception ex)
            {
                _spoilerResolver.WarnRateLimited(
                    "tagcache-played-probe:" + ex.GetType().FullName,
                    $"Spoiler Guard tag-cache strip: played-state query failed for {user.Id}: {ex.Message}");
                played.Clear();
            }
            return played;
        }

        /// <summary>
        /// Series ids and series presentation keys of every show
        /// <paramref name="user"/> has played at least one episode of
        /// (tag-cache Spoiler Guard strip: gates the per-season watched probe).
        /// On error returns null, so every season is probed as before.
        /// </summary>
        private (HashSet<Guid> Ids, HashSet<string> Keys)? LoadPlayedSeriesForTagStrip(JUser user)
        {
            try
            {
                var ids = new HashSet<Guid>();
                var keys = new HashSet<string>(StringComparer.Ordinal);
                foreach (var item in _libraryManager.GetItemList(new InternalItemsQuery(user)
                {
                    IncludeItemTypes = new[] { BaseItemKind.Episode },
                    IsPlayed = true,
                    Recursive = true,
                    GroupByPresentationUniqueKey = false,
                    DtoOptions = new MediaBrowser.Controller.Dto.DtoOptions(false),
                }))
                {
                    if (item is not Episode ep) continue;
                    if (ep.SeriesId != Guid.Empty) ids.Add(ep.SeriesId);
                    if (!string.IsNullOrEmpty(ep.SeriesPresentationUniqueKey)) keys.Add(ep.SeriesPresentationUniqueKey);
                }
                return (ids, keys);
            }
            catch (Exception ex)
            {
                _spoilerResolver.WarnRateLimited(
                    "tagcache-played-series-probe:" + ex.GetType().FullName,
                    $"Spoiler Guard tag-cache strip: played-series query failed for {user.Id}: {ex.Message}");
                return null;
            }
        }
    }
}
