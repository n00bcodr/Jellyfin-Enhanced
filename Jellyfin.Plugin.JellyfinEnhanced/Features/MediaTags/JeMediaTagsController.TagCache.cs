using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using System.Security.Cryptography;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags
{
    public partial class JeMediaTagsController
    {
        [HttpGet("tag-cache/{userId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetTagCache(Guid userId, [FromQuery] long? since = null, [FromQuery] string? known = null, [FromQuery] string? after = null, [FromQuery] int? limit = null)
        {
            if (JellyfinEnhanced.Instance?.Configuration?.TagCacheServerMode != true)
            {
                return NotFound();
            }

            var authorizationResult = AuthorizeUserAccess(userId, out var user);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            // Version/timestamp come from the same generation capture as the
            // cache contents (see GetCacheForUser): a cursor newer than the
            // returned items would let clients skip updates permanently, and a
            // mixed pre-publish stamp (timestamp 0) would disable their delta
            // refresh entirely.
            // Spoiler Guard tag-strip: when SpoilerBlur is on with any tag-relevant
            // strip toggle, walk the cache and zero out matching fields for unwatched
            // episodes whose parent series is in the spoiler list. Needed because the
            // JE tag-pipeline reads serverCache BEFORE GetTagData, so card overlays
            // would still leak despite the toggle. Mirrors the per-batch strip in GetTagData;
            // the logic lives in SpoilerTagDataStripper (shared with native poster tags).
            var spCfg = JellyfinEnhanced.Instance?.Configuration;
            // The user's effective Spoiler Guard strip policy, or null when nothing needs
            // stripping for them. Strict-read so corruption is observable (rate-limited
            // warn) rather than silently passing through. Resolved BEFORE the cache
            // read so a delta request can include the guarded entries (below).
            // Loaded for the resolved user, not the route value: an empty route id
            // resolves to the caller, whose own guard must still apply.
            var spPolicy = Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerTagDataStripper.IsConfigured(spCfg)
                ? Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerTagDataStripper.CreatePolicy(spCfg, LoadSpoilerStateForTagStrip(user.Id))
                : null;

            // A delta (?since=) only carries entries the library changed, but a
            // guarded entry is also rewritten by this user's PLAYED state: an
            // episode watched since their last load is no longer stripped, one
            // just added to their guard list now is. Clients keep the cache
            // across page loads (tag-cache-store.js), so every guarded entry
            // rides along with each delta: a guard list's worth of entries,
            // stripped below exactly like a full load, instead of the whole cache.
            Func<string, Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.TagCacheEntry, bool>? guardedRider =
                since.HasValue && spPolicy != null
                    ? (key, e) => _spoilerTagDataStripper.GetGuardedKind(spPolicy.State, key, e) != null
                    : null;
            // Fingerprint of how this user's entries are filtered and stripped:
            // which cache entries their access excludes (from the same access
            // set that filtered `items`, see GetCacheForUser) and, under Spoiler
            // Guard, the effective strip flags and the set of guarded entries. A
            // full load and a delta compute the same value (every guarded entry
            // rides on a delta), and it changes exactly when a delta could not
            // correct a stored copy: an entry no longer visible to the user, an
            // item leaving the guard set, or the strip policy changing, so the
            // client replaces its copy instead (tags/tag-pipeline.js).
            var stripFingerprint = "none";

            // Server clock at capture (taken before reading the cache, so it never
            // post-dates the data): clients order stored snapshots by it. Unlike
            // the cache version, it keeps moving forward across a restart that
            // restores an older on-disk cache.
            var servedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            // The body is serialized here, once, into the bytes that are sent AND
            // hashed for the ETag (see Respond below) — with the options MVC's
            // formatter would have applied to Ok(payload), so it is the same body.
            var jsonOptions = TagCacheJsonOptions();

            // A full load for a user without a Spoiler Guard strip is exactly the
            // generation's entries their access set admits, so its serialized
            // `items` is shared across requests and users with the same access
            // (every unrestricted user, typically): after a rebuild every client
            // downloads the whole cache, and re-serializing tens of MB per client
            // used to take seconds of CPU and hundreds of MB each. Those clients
            // arrive together, so the serialization runs one at a time and the
            // waiters find the first one's copy. While the cache is being
            // mutated nothing is shared (TryGetSerializedItems reports it not
            // shareable) and the request is serialized on its own below, like
            // the delta and strip paths.
            // A paged full load (`limit`, then `after` = the previous page's `next`): one bounded page of the
            // same generation. Its strip fingerprint covers every guarded entry, as a delta's does, so every
            // page and the catch-up delta carry the same filterRevision.
            if (!since.HasValue && limit is > 0)
            {
                var pageItems = _tagCacheService.GetCachePageForUser(user, string.IsNullOrEmpty(after) ? null : after, Math.Clamp(limit.Value, 100, 5000), out var pageVersion, out var pageTimestamp, out var pageAccess, out var next);
                if (spPolicy != null)
                {
                    var guarded = _tagCacheService.GetCacheForUser(user, out _, out _, out _, long.MaxValue, guardedRider ?? ((key, e) => _spoilerTagDataStripper.GetGuardedKind(spPolicy.State, key, e) != null));
                    stripFingerprint = _spoilerTagDataStripper.StripTagCache(spPolicy, user, guarded);
                    _spoilerTagDataStripper.StripTagCache(spPolicy, user, pageItems);
                }

                return Respond(pageVersion, pageTimestamp, pageAccess, JsonSerializer.SerializeToUtf8Bytes(pageItems, jsonOptions), pageItems.Count, null, next);
            }

            if (!since.HasValue && spPolicy == null)
            {
                if (_tagCacheService.TryGetSerializedItems(user, out var sharedVersion, out var sharedTimestamp, out var sharedAccessRevision, out var sharedItemsJson, out var sharedCount, out var shareable))
                {
                    return Respond(sharedVersion, sharedTimestamp, sharedAccessRevision, sharedItemsJson, sharedCount);
                }

                if (shareable)
                {
                    _tagCacheSerializationGate.Wait();
                    try
                    {
                        if (!_tagCacheService.TryGetSerializedItems(user, out sharedVersion, out sharedTimestamp, out sharedAccessRevision, out sharedItemsJson, out sharedCount, out _))
                        {
                            var sharedItems = _tagCacheService.GetShareableCacheForUser(user, out sharedVersion, out sharedTimestamp, out sharedAccessRevision, out var shareKey);
                            sharedItemsJson = JsonSerializer.SerializeToUtf8Bytes(sharedItems, jsonOptions);
                            sharedCount = sharedItems.Count;
                            if (shareKey != null)
                            {
                                _tagCacheService.StoreSerializedItems(shareKey, sharedItemsJson, sharedCount);
                            }
                        }
                    }
                    finally
                    {
                        _tagCacheSerializationGate.Release();
                    }

                    return Respond(sharedVersion, sharedTimestamp, sharedAccessRevision, sharedItemsJson, sharedCount);
                }
            }

            var items = _tagCacheService.GetCacheForUser(user, out var cacheVersion, out var cacheTimestamp, out var accessRevision, out var removed, since, guardedRider);

            if (spPolicy != null)
            {
                stripFingerprint = _spoilerTagDataStripper.StripTagCache(spPolicy, user, items);
            }

            // A caller whose filter differs only in access reconciles its copy from this delta (`visible` drops
            // what it can no longer see). The entries it still sees whose projection depends on access (a
            // series' facts from an episode it lost, a collection's Custom Tag or Leaving fact) kept their
            // LastUpdated, so they ride along freshly projected; the walk runs again only on that mismatch.
            if (since.HasValue && known != null && !string.Equals(known, FilterRevisionOf(accessRevision), StringComparison.Ordinal))
            {
                Func<string, Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.TagCacheEntry, bool> reconcileRider = guardedRider == null
                    ? (_, e) => Services.TagCacheService.ProjectsAccess(e)
                    : (key, e) => Services.TagCacheService.ProjectsAccess(e) || guardedRider(key, e);
                items = _tagCacheService.GetCacheForUser(user, out cacheVersion, out cacheTimestamp, out accessRevision, out removed, since, reconcileRider);
                if (spPolicy != null)
                {
                    stripFingerprint = _spoilerTagDataStripper.StripTagCache(spPolicy, user, items);
                }
            }

            // `items` is final (post Spoiler Guard strip above); serialized once.
            var itemsJson = JsonSerializer.SerializeToUtf8Bytes(items, jsonOptions);
            return Respond(cacheVersion, cacheTimestamp, accessRevision, itemsJson, items.Count, removed);

            string FilterRevisionOf(string access) => Convert.ToHexString(
                SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(access + "#" + stripFingerprint + "#ratings:" + Services.TagCacheService.SourceRatingsConfigured)), 0, 12);

            // The rest of the response — review ratings, filterRevision, body,
            // ETag/304 — for either source of `items`.
            IActionResult Respond(long version, long timestamp, string access, byte[] itemsBytes, int itemCount, string[]? removedIds = null, string? next = null)
            {
                // The poster review chips resolve from this map instead of asking
                // /reviews/ratings for every page of cards: it holds the average for
                // every item that has a rated review visible to THIS viewer (same
                // reviews, same visibility rule and same rating filter as that
                // endpoint), keyed "mediaType:tmdbKey". A key that is absent has no
                // visible rated review. Sent with full loads and deltas alike, since
                // reviews change independently of the tag cache; null (omitted) when
                // the chips are switched off, which tells the client to skip them.
                Dictionary<string, object>? reviewRatings = null;
                if (JellyfinEnhanced.Instance?.Configuration is { ShowUserReviews: true, ShowUserRatingOnPosters: true })
                {
                    reviewRatings = new Dictionary<string, object>(StringComparer.Ordinal);
                    var ctx = CreateReviewVisibilityContext(nameof(GetTagCache), "review ratings");
                    foreach (var (key, sum, count) in AggregateVisibleReviewRatings(ctx, _ => true))
                    {
                        reviewRatings[key] = new { average = sum / count, count };
                    }
                }

                var filterRevision = FilterRevisionOf(access);
                // The same fingerprint without the access part: when only access changed (an item the user cannot
                // see was added, or one they could see was hidden), a delta can still correct a stored copy by
                // dropping what is no longer `visible`; any other change still needs a full download.
                var filterBase = Convert.ToHexString(
                    SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(stripFingerprint + "#ratings:" + Services.TagCacheService.SourceRatingsConfigured)), 0, 12);
                var visible = since.HasValue && known != null && !string.Equals(known, filterRevision, StringComparison.Ordinal)
                    ? _tagCacheService.VisibleKeys(user, version)
                    : null;

                // Body { version, timestamp, servedAt, filterRevision, [removed,] count, items,
                // reviewRatings }, assembled around the serialized items without
                // another serialization. The ETag is a hash of the FINAL response
                // body minus servedAt (see TagCacheResponseBody.ETag), not of
                // cacheVersion: two users at the same version can legitimately
                // receive different stripped bodies, and an ETag keyed on version
                // alone would let one user's stripped body satisfy another user's
                // conditional request.
                var body = Services.TagCacheResponseBody.Compose(
                    jsonOptions,
                    version,
                    timestamp,
                    servedAt,
                    filterRevision,
                    itemCount,
                    itemsBytes,
                    reviewRatings == null ? null : JsonSerializer.SerializeToUtf8Bytes(reviewRatings, jsonOptions),
                    removedIds,
                    filterBase,
                    visible,
                    next);

                // no-cache (not no-store): the client may keep a copy to revalidate against,
                // but must always revalidate. Freshness is unchanged, this only avoids
                // re-sending an unchanged multi-MB body.
                Response.Headers["Cache-Control"] = "private, no-cache";
                Response.Headers["ETag"] = body.ETag;

                if (Request.Headers.TryGetValue("If-None-Match", out var ifNoneMatch)
                    && ifNoneMatch.ToString().Contains(body.ETag, StringComparison.Ordinal))
                {
                    return StatusCode(304);
                }

                return body.ToActionResult();
            }
        }

        // The JsonSerializerOptions of the formatter MVC runs for an
        // application/json ObjectResult on this host. GetTagCache serializes its
        // own body (once, into the bytes it sends and hashes), so it has to use
        // exactly what Ok(payload) would have: resolved the way MVC's selector
        // does — the first registered JSON formatter that writes
        // application/json (Jellyfin registers its own PascalCase profile
        // formatter ahead of the default one) — and cached, since the formatter
        // list is fixed for the process. The one difference: a copy that leaves
        // out TagCacheEntry.LatestEpisodeId and StatusEpisodeIds, which only the
        // server's per-user filter reads (the disk snapshot keeps them).
        private static JsonSerializerOptions? _tagCacheJsonOptions;

        // One shareable full-load serialization at a time (see GetTagCache):
        // waiters re-check the shared copy once they get in, so a burst of
        // clients after a rebuild costs one serialization, not one each.
        private static readonly SemaphoreSlim _tagCacheSerializationGate = new(1, 1);

        private JsonSerializerOptions TagCacheJsonOptions()
        {
            var options = _tagCacheJsonOptions;
            if (options != null) return options;

            var formatters = HttpContext.RequestServices.GetRequiredService<IOptions<MvcOptions>>().Value.OutputFormatters;
            foreach (var formatter in formatters)
            {
                if (formatter is Microsoft.AspNetCore.Mvc.Formatters.SystemTextJsonOutputFormatter json
                    && json.SupportedMediaTypes.Any(type =>
                        Microsoft.Net.Http.Headers.MediaTypeHeaderValue.TryParse(type, out var parsed)
                        && parsed.MediaType.Equals("application/json", StringComparison.OrdinalIgnoreCase)))
                {
                    options = json.SerializerOptions;
                    break;
                }
            }

            options ??= HttpContext.RequestServices.GetRequiredService<IOptions<Microsoft.AspNetCore.Mvc.JsonOptions>>().Value.JsonSerializerOptions;
            options = new JsonSerializerOptions(options)
            {
                TypeInfoResolver = System.Text.Json.Serialization.Metadata.JsonTypeInfoResolver.WithAddedModifier(
                    options.TypeInfoResolver ?? new System.Text.Json.Serialization.Metadata.DefaultJsonTypeInfoResolver(),
                    static typeInfo =>
                    {
                        if (typeInfo.Type != typeof(Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.TagCacheEntry)) return;
                        foreach (var property in typeInfo.Properties)
                        {
                            // By CLR name: the JSON name follows the host's naming policy.
                            if (property.AttributeProvider is System.Reflection.PropertyInfo clrProperty
                                && (clrProperty.Name == nameof(Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.TagCacheEntry.LatestEpisodeId)
                                    || clrProperty.Name == nameof(Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.TagCacheEntry.StatusEpisodeIds)
                                    || clrProperty.Name == nameof(Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.TagCacheEntry.QualityEpisodeIds)
                                    || clrProperty.Name == nameof(Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.TagCacheEntry.NextEpisodePremiere)))
                            {
                                property.ShouldSerialize = static (_, _) => false;
                            }
                        }
                    }),
            };
            _tagCacheJsonOptions = options;
            return options;
        }

        [HttpPost("tag-data/{userId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetTagData(
            Guid userId,
            [FromBody] string[] ids,
            [FromQuery] string? mediaSourceId = null,
            [FromQuery] bool latestEpisode = false)
        {
            var authorizationResult = AuthorizeUserAccess(userId, out var user);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (ids == null || ids.Length == 0)
            {
                return BadRequest(new { error = "ids array required" });
            }

            if (ids.Length > 200)
            {
                return BadRequest(new { error = "Maximum 200 items per request" });
            }

            // A selected version must go through the same projection as the normal
            // tag-data path. Filtering here prevents details-page callers from
            // bypassing MediaStreamLanguageResolver and losing Matroska BCP-47
            // regions (for example en-US -> eng).
            //
            // Keeping this selection inside tag-data also means future callers do
            // not need a second language-resolution implementation.
            List<MediaSourceInfo> SelectTagDataMediaSources(
                IEnumerable<MediaSourceInfo> sources)
            {
                if (string.IsNullOrWhiteSpace(mediaSourceId))
                {
                    return sources.ToList();
                }

                return sources
                    .Where(source => string.Equals(
                        source.Id,
                        mediaSourceId,
                        StringComparison.OrdinalIgnoreCase))
                    .ToList();
            }

            // Subtitle languages for the Language Tags overlay, the way the server
            // tag cache stores them (TagCacheService.ExtractMediaData): lower-cased,
            // languageless codes ("und", "mul", "qaa"…) dropped, one per language however many SDH tracks carry
            // it, forced-only languages left out. Subtitle languages are Jellyfin's
            // own (the Matroska BCP-47 reader only aligns audio tracks).
            static string[] TagDataSubtitleLanguages(List<MediaSourceInfo> sources) => sources
                .SelectMany(source => (IEnumerable<MediaStream>?)source.MediaStreams ?? Array.Empty<MediaStream>())
                .Where(stream => stream.Type == MediaStreamType.Subtitle && !stream.IsForced)
                .Select(stream => Services.TagCacheService.NormalizeStreamLanguage(stream.Language))
                .OfType<string>()
                .Distinct(StringComparer.Ordinal)
                .ToArray();

            // Age rating for the Age Rating Tags overlay. Seasons/Episodes rarely
            // carry their own, so fall back to the Series — resolved here (not on
            // the client) so batch mode matches the server tag cache, which does
            // the same in TagCacheService.BuildEntryForItem. The series-level age
            // rating is never spoiler-stripped (it reveals nothing about the plot
            // and Jellyfin shows it in the series header), but an Episode/Season's
            // OWN rating can differ from the series (a TV-MA episode of a TV-14
            // show) and Jellyfin never displays it — so the Spoiler Guard stubs
            // below pass seriesOnly when ratings are stripped.
            // A batch is typically one series' worth of episodes, so the parent
            // lookup is memoized per request rather than repeated per item.
            var seriesRatingMemo = new Dictionary<Guid, string?>();
            // Library id for the tag look rules, as the server tag cache stores
            // it (Seasons/Episodes take their Series'), memoized per series.
            var seriesLibraryMemo = new Dictionary<Guid, string?>();
            string? TagDataLibraryId(BaseItem tagItem) => Jellyfin.Plugin.JellyfinEnhanced.Shared.Library.ItemLibraryResolver.Resolve(_libraryManager, tagItem, null, seriesLibraryMemo);
            // Custom tag rule ids, as the server tag cache stores them, with collection
            // matches only for collections this user can access. The Spoiler Guard stubs
            // drop them with the genres (SpoilerStripTags): a tag or collection label can
            // be a plot fact.
            var customSeriesMemo = new Dictionary<Guid, BaseItem?>();
            string[]? TagDataCustomTags(BaseItem tagItem) => _tagCacheService.GetCustomTags(tagItem, user, customSeriesMemo);
            string? ResolveTagDataOfficialRating(BaseItem tagItem, bool seriesOnly = false)
            {
                if (!seriesOnly && !string.IsNullOrWhiteSpace(tagItem.OfficialRating))
                {
                    return tagItem.OfficialRating;
                }

                var parentSeriesId = tagItem switch
                {
                    MediaBrowser.Controller.Entities.TV.Episode e => e.SeriesId,
                    MediaBrowser.Controller.Entities.TV.Season s => s.SeriesId,
                    _ => Guid.Empty,
                };
                if (parentSeriesId == Guid.Empty)
                {
                    return null;
                }

                if (!seriesRatingMemo.TryGetValue(parentSeriesId, out var parentRating))
                {
                    parentRating = _libraryManager.GetItemById<BaseItem>(parentSeriesId)?.OfficialRating;
                    parentRating = string.IsNullOrWhiteSpace(parentRating) ? null : parentRating;
                    seriesRatingMemo[parentSeriesId] = parentRating;
                }

                return parentRating;
            }

            // Spoiler Guard short-circuit: when the master switch + any tag-relevant
            // strip toggle are on and the user has entries in their spoiler list, skip
            // tag data for unwatched episodes. Loaded once per request (not per item).
            // Title replacement / overview strip MUST also enter the stub path, else
            // the non-stub projection leaks raw item.Path / DisplayTitle / MediaSource
            // path+name despite SpoilerReplaceTitle — closing this per-batch endpoint too.
            // Per-category overrides apply on top of admin policy (same "opt-out wins"
            // contract as ShouldStrip); see SpoilerTagDataStripper.CreatePolicy.
            var spoilerCfg = JellyfinEnhanced.Instance?.Configuration;
            Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerTagStripPolicy? spoilerPolicy = null;
            if (Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerTagDataStripper.IsConfigured(spoilerCfg))
            {
                // The resolved user's state (see GetTagCache): an empty route id is the caller.
                spoilerPolicy = Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerTagDataStripper.CreatePolicy(spoilerCfg, LoadSpoilerStateForTagStrip(user.Id));
            }
            var stripTagsEnabled = spoilerPolicy != null;
            var spStripGenres = spoilerPolicy?.StripGenres == true;
            var spStripRatings = spoilerPolicy?.StripRatings == true;
            var spReplaceTitle = spoilerPolicy?.ReplaceTitle == true;

            // Status Tags dates (Unix ms, like the server tag cache's entries; null
            // is omitted). The episode-derived facts (LatestEpisodeAdded and the
            // schedule/milestone facts) cost one episode query per Series/Season,
            // so they are only resolved when the client's Status Tags ask for them
            // (?latestEpisode=true), and through the user so only episodes they can
            // see count (the server cache gets the same rules from
            // StatusTagsEpisodeFacts and filters them per user instead).
            long? TagDataPremiereDate(BaseItem tagItem) =>
                tagItem is MediaBrowser.Controller.Entities.Movies.Movie
                    || tagItem is MediaBrowser.Controller.Entities.TV.Series
                    || tagItem is MediaBrowser.Controller.Entities.TV.Episode
                    ? Services.TagCacheService.ToUnixMilliseconds(tagItem.PremiereDate)
                    : null;
            string? TagDataSeriesStatus(BaseItem tagItem) =>
                tagItem is MediaBrowser.Controller.Entities.TV.Series statusSeries ? statusSeries.Status?.ToString() : null;
            // A few sorted, limited queries per container (never every episode),
            // once per container per request.
            var episodeFactsMemo = new Dictionary<Guid, (long? LatestAdded, Services.StatusTagsEpisodeFacts? Facts)>();
            var factsNow = DateTime.UtcNow;
            (long? LatestAdded, Services.StatusTagsEpisodeFacts? Facts) TagDataEpisodeFacts(BaseItem tagItem)
            {
                if (!latestEpisode || tagItem is not (MediaBrowser.Controller.Entities.TV.Series or MediaBrowser.Controller.Entities.TV.Season))
                {
                    return (null, null);
                }

                if (episodeFactsMemo.TryGetValue(tagItem.Id, out var memo)) return memo;
                return episodeFactsMemo[tagItem.Id] = Services.StatusTagsEpisodeLookup.Load(_libraryManager, tagItem, () => new InternalItemsQuery(user)
                {
                    ParentId = tagItem.Id,
                    IncludeItemTypes = new[] { BaseItemKind.Episode },
                    Recursive = true,
                    IsVirtualItem = false,
                    DtoOptions = new DtoOptions(false) { EnableImages = false, EnableUserData = false },
                }, factsNow);
            }

            // The Series/Movie stubs carry no provider ids, but a trending rank is
            // not a spoiler, so the Status Tags get the TMDB id on its own (the
            // server tag cache's strip keeps TmdbId the same way).
            string? TagDataTmdbId(BaseItem tagItem) =>
                tagItem.ProviderIds?.TryGetValue("Tmdb", out var tmdbId) == true && !string.IsNullOrEmpty(tmdbId) ? tmdbId : null;

            // Hydrate through the viewer before enrichment; denied ids never trigger upstream requests.
            var accessibleItems = ids.Where(id => Guid.TryParse(id?.Trim(), out _))
                .Select(id => _libraryManager.GetItemById<BaseItem>(Guid.Parse(id.Trim()), user))
                .Where(item => item != null).Select(item => item!).ToArray();
            _tagCacheService.WarmSourceRatingsForRequest(accessibleItems, HttpContext?.RequestAborted ?? CancellationToken.None);
            _tagCacheService.WarmLogosForItems(accessibleItems, HttpContext?.RequestAborted ?? CancellationToken.None);
            _tagCacheService.QueueScenesRefresh(accessibleItems);
            var results = new List<object>(accessibleItems.Length);

            // Process items sequentially (Jellyfin library manager is not fully thread-safe for GetMediaSources).
            foreach (var item in accessibleItems)
            {
                var kind = item.GetBaseItemKind();
                var isContainer = kind == BaseItemKind.Series || kind == BaseItemKind.Season;
                var spoilerStub = stripTagsEnabled
                    ? _spoilerTagDataStripper.GetTagDataStub(spoilerPolicy!, user, item)
                    : Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerTagDataStub.None;

                // Spoiler Guard tag-strip: for an unwatched Episode of a guarded
                // series, return an Id+Type-only stub so the frontend tag renderers
                // draw nothing. The pipeline still treats the item as processed
                // (no retry loop) — it just produces zero overlays.
                if (spoilerStub == Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerTagDataStub.Episode
                    && item is MediaBrowser.Controller.Entities.TV.Episode spEp)
                {
                    // When SpoilerReplaceTitle is on, the field-strip filter rewrites
                    // Name to "Season X, Episode Y"; the stub must agree — leaking the
                    // raw Name here would defeat the title toggle.
                    string? stubName = item.Name;
                    if (spReplaceTitle
                        && spEp.IndexNumber.HasValue
                        && spEp.ParentIndexNumber.HasValue)
                    {
                        stubName = $"Season {spEp.ParentIndexNumber.Value}, Episode {spEp.IndexNumber.Value}";
                    }

                    // Compute MediaStreams when SpoilerStripTags is off so quality /
                    // language overlays still render under rating-only strip.
                    // MediaSources is intentionally LEFT NULL even then: it exposes
                    // filename + display name that commonly leak the raw episode title
                    // (e.g. "S05E14 - The Death of Optimus Prime.mkv"), defeating
                    // SpoilerReplaceTitle. Losing the IMAX/3D media-stub overlays on
                    // stripped episodes only is the correct trade-off.
                    List<object>? stubStreams = null;
                    List<object>? stubSources = null;
                    string[]? stubSubtitles = null;
                    if (!spStripGenres)
                    {
                        var stubMediaSources =
                            SelectTagDataMediaSources(spEp.GetMediaSources(false));
                        stubSubtitles = TagDataSubtitleLanguages(stubMediaSources);
                        stubStreams = stubMediaSources
                            .SelectMany(source => MediaStreamLanguageResolver.Resolve(source, spEp.Path, _matroskaLanguageCache).Select(r => (SourceId: source.Id, Resolved: r)))
                            .Where(resolved =>
                                resolved.Resolved.Stream.Type == MediaStreamType.Video
                                || resolved.Resolved.Stream.Type == MediaStreamType.Audio
                                || resolved.Resolved.Stream.Type == MediaStreamType.Subtitle)
                            .Select(resolved =>
                            {
                                var s = resolved.Resolved.Stream;
                                return (object)new
                                {
                                    Type = s.Type.ToString(),
                                    SourceId = resolved.SourceId,
                                    Language = resolved.Resolved.Language,
                                    Codec = s.Codec,
                                    CodecTag = s.CodecTag,
                                    Profile = s.Profile,
                                    Height = s.Height,
                                    Width = s.Width,
                                    AspectRatio = s.AspectRatio,
                                    RealFrameRate = s.RealFrameRate,
                                    AverageFrameRate = s.AverageFrameRate,
                                    IsInterlaced = s.IsInterlaced,
                                    IsHearingImpaired = SubtitleAccessibility.IsSdh(s.IsHearingImpaired, s.Title, s.DisplayTitle),
                                    Title = default(string?),
                                    Channels = s.Channels,
                                    ChannelLayout = s.ChannelLayout,
                                    VideoRangeType = s.VideoRangeType,
                                    VideoRange = s.Type == MediaStreamType.Video ? Shared.MediaTags.PosterTags.Resolution.QualityTagRules.CoarseRange(s.VideoRangeType.ToString(), s.VideoRange.ToString()) : null,
                                    // DisplayTitle's GETTER prepends the raw Title field,
                                    // which on user-muxed mkvs (MakeMKV / Plex / Sonarr
                                    // renamers) commonly carries the episode name — under
                                    // SpoilerReplaceTitle that leaks via the stream projection.
                                    // Null it; qualitytags.js recomputes overlay text from
                                    // Codec / Height / VideoRangeType / Profile, not Title.
                                    DisplayTitle = default(string?),
                                };
                            })
                            .ToList();
                        // stubSources stays null — see comment above.
                    }

                    // Per-field strip: a field is preserved when its toggle is OFF,
                    // nulled when ON. SeriesId is nulled only when ratings are
                    // stripped (it controls the rating-fallback to the parent series).
                    results.Add(new
                    {
                        Id = item.Id,
                        Type = kind.ToString(),
                        Genres = spStripGenres ? Array.Empty<string>() : (spEp.Genres ?? Array.Empty<string>()),
                        CommunityRating = spStripRatings ? (float?)null : spEp.CommunityRating,
                        CriticRating = spStripRatings ? (float?)null : spEp.CriticRating,
                        Ratings = spStripRatings ? null : _tagCacheService.GetSourceRatings(spEp),
                        // Hide tags strips the Logos group like genres (shared/native strip too).
                        Logos = spStripGenres ? null : _tagCacheService.GetLogos(spEp),
                        OfficialRating = ResolveTagDataOfficialRating(spEp, seriesOnly: spStripRatings),
                        LibraryId = TagDataLibraryId(spEp),
                        CustomTags = spStripGenres ? null : TagDataCustomTags(spEp),
                        Leaving = spStripGenres ? null : _tagCacheService.GetLeavingForUser(spEp, user),
                        // Suppress the parent-series rating fallback only when the
                        // rating strip is requested; leaving SeriesId set under tag-only
                        // strip lets the rating overlay keep rendering.
                        SeriesId = spStripRatings ? (Guid?)null : spEp.SeriesId,
                        ProviderIds = default(IDictionary<string, string>),
                        Name = stubName,
                        RunTimeTicks = item.RunTimeTicks,
                        Path = default(string),
                        MediaStreams = stubStreams,
                        MediaSources = stubSources,
                        SubtitleLanguages = stubSubtitles,
                        FirstEpisode = (object?)null,
                        // Align with the field-strip filter (which empties Tags).
                        Tags = spStripGenres ? Array.Empty<string>() : (spEp.Tags ?? Array.Empty<string>()),
                        // When it was added is not a spoiler (Jellyfin lists it as Date Added).
                        DateCreated = Services.TagCacheService.ToUnixMilliseconds(spEp.DateCreated),
                    });
                    continue;
                }

                // Series-stub: for a Series the user has Spoiler Guard on, return the
                // strip stub. Covers home-rail cards bound to seriesId — e.g. NextUp /
                // Continue Watching with "Use episode images" OFF, where cards show the
                // series poster and the JE tag pipeline fetches series-level tag data.
                if (spoilerStub == Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerTagDataStub.Series
                    && item is MediaBrowser.Controller.Entities.TV.Series spSeries)
                {
                    string? stubName = item.Name;
                    if (spReplaceTitle)
                    {
                        // Series titles are rarely spoilery; replace only under the
                        // explicit title-strip toggle, matching the field-strip filter.
                        stubName = string.IsNullOrWhiteSpace(spoilerCfg!.SpoilerOverviewPlaceholder)
                            ? "Spoiler Guard activated"
                            : spoilerCfg.SpoilerOverviewPlaceholder;
                    }
                    var seriesFacts = TagDataEpisodeFacts(spSeries);
                    results.Add(new
                    {
                        Id = item.Id,
                        Type = kind.ToString(),
                        Genres = spStripGenres ? Array.Empty<string>() : (spSeries.Genres ?? Array.Empty<string>()),
                        CommunityRating = spStripRatings ? (float?)null : spSeries.CommunityRating,
                        CriticRating = spStripRatings ? (float?)null : spSeries.CriticRating,
                        Ratings = spStripRatings ? null : _tagCacheService.GetSourceRatings(spSeries),
                        Awards = spStripRatings ? null : _tagCacheService.GetAwards(spSeries),
                        Logos = spStripGenres ? null : _tagCacheService.GetLogos(spSeries),
                        OfficialRating = ResolveTagDataOfficialRating(spSeries),
                        LibraryId = TagDataLibraryId(spSeries),
                        CustomTags = spStripGenres ? null : TagDataCustomTags(spSeries),
                        Leaving = spStripGenres ? null : _tagCacheService.GetLeavingForUser(spSeries, user),
                        SeriesId = default(Guid?),
                        ProviderIds = default(IDictionary<string, string>),
                        Name = stubName,
                        RunTimeTicks = item.RunTimeTicks,
                        Path = (string?)null,
                        MediaStreams = (List<object>?)null,
                        MediaSources = (List<object>?)null,
                        FirstEpisode = (object?)null,
                        Tags = spStripGenres ? Array.Empty<string>() : (spSeries.Tags ?? Array.Empty<string>()),
                        DateCreated = Services.TagCacheService.ToUnixMilliseconds(spSeries.DateCreated),
                        PremiereDate = TagDataPremiereDate(spSeries),
                        LatestEpisodeAdded = seriesFacts.LatestAdded,
                        // A new season or the show's status says nothing about the plot.
                        Status = TagDataSeriesStatus(spSeries),
                        LatestEpisodeAired = seriesFacts.Facts?.LatestAired,
                        LatestEpisodeIndex = seriesFacts.Facts?.LatestIndex,
                        SeasonPremiere = seriesFacts.Facts?.SeasonPremiere,
                        TmdbId = TagDataTmdbId(spSeries),
                    });
                    continue;
                }

                // Movie-stub: for an unwatched Movie in the user's spoiler scope,
                // return the same Id+Type stub so JE tag overlays don't render on the
                // blurred poster. Mirrors the Episode stub.
                if (spoilerStub == Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerTagDataStub.Movie
                    && item is MediaBrowser.Controller.Entities.Movies.Movie spMovie)
                {
                    // Movie title is NOT rewritten under SpoilerReplaceTitle — it stays
                    // visible in overlays/tooltips (matching the field-strip movie carve-out).
                    string? stubName = item.Name;

                    List<object>? stubStreams = null;
                    string[]? stubSubtitles = null;
                    if (!spStripGenres)
                    {
                        var stubMs =
                            SelectTagDataMediaSources(spMovie.GetMediaSources(false));
                        stubSubtitles = TagDataSubtitleLanguages(stubMs);
                        stubStreams = stubMs
                            .SelectMany(source => MediaStreamLanguageResolver.Resolve(source, spMovie.Path, _matroskaLanguageCache).Select(r => (SourceId: source.Id, Resolved: r)))
                            .Where(resolved =>
                                resolved.Resolved.Stream.Type == MediaStreamType.Video
                                || resolved.Resolved.Stream.Type == MediaStreamType.Audio
                                || resolved.Resolved.Stream.Type == MediaStreamType.Subtitle)
                            .Select(resolved =>
                            {
                                var s = resolved.Resolved.Stream;
                                return (object)new
                                {
                                    Type = s.Type.ToString(),
                                    SourceId = resolved.SourceId,
                                    Language = resolved.Resolved.Language,
                                    Codec = s.Codec,
                                    CodecTag = s.CodecTag,
                                    Profile = s.Profile,
                                    Height = s.Height,
                                    Width = s.Width,
                                    AspectRatio = s.AspectRatio,
                                    RealFrameRate = s.RealFrameRate,
                                    AverageFrameRate = s.AverageFrameRate,
                                    IsInterlaced = s.IsInterlaced,
                                    IsHearingImpaired = SubtitleAccessibility.IsSdh(s.IsHearingImpaired, s.Title, s.DisplayTitle),
                                    Title = default(string?),
                                    Channels = s.Channels,
                                    ChannelLayout = s.ChannelLayout,
                                    VideoRangeType = s.VideoRangeType,
                                    VideoRange = s.Type == MediaStreamType.Video ? Shared.MediaTags.PosterTags.Resolution.QualityTagRules.CoarseRange(s.VideoRangeType.ToString(), s.VideoRange.ToString()) : null,
                                    DisplayTitle = default(string?),
                                };
                            })
                            .ToList();
                    }

                    results.Add(new
                    {
                        Id = item.Id,
                        Type = kind.ToString(),
                        Genres = spStripGenres ? Array.Empty<string>() : (spMovie.Genres ?? Array.Empty<string>()),
                        CommunityRating = spStripRatings ? (float?)null : spMovie.CommunityRating,
                        CriticRating = spStripRatings ? (float?)null : spMovie.CriticRating,
                        Ratings = spStripRatings ? null : _tagCacheService.GetSourceRatings(spMovie),
                        Awards = spStripRatings ? null : _tagCacheService.GetAwards(spMovie),
                        Logos = spStripGenres ? null : _tagCacheService.GetLogos(spMovie),
                        Scenes = spStripGenres ? null : _tagCacheService.GetScenes(spMovie),
                        OfficialRating = ResolveTagDataOfficialRating(spMovie),
                        LibraryId = TagDataLibraryId(spMovie),
                        CustomTags = spStripGenres ? null : TagDataCustomTags(spMovie),
                        Leaving = spStripGenres ? null : _tagCacheService.GetLeavingForUser(spMovie, user),
                        SeriesId = default(Guid?),
                        ProviderIds = default(IDictionary<string, string>),
                        Name = stubName,
                        RunTimeTicks = item.RunTimeTicks,
                        Path = default(string),
                        MediaStreams = stubStreams,
                        MediaSources = default(List<object>),
                        SubtitleLanguages = stubSubtitles,
                        FirstEpisode = (object?)null,
                        Tags = spStripGenres ? Array.Empty<string>() : (spMovie.Tags ?? Array.Empty<string>()),
                        DateCreated = Services.TagCacheService.ToUnixMilliseconds(spMovie.DateCreated),
                        PremiereDate = TagDataPremiereDate(spMovie),
                        TmdbId = TagDataTmdbId(spMovie),
                    });
                    continue;
                }

                // BoxSet (Collection) DTOs pass through unstripped: the collection's own
                // art is the entry point the user just clicked (like Series), so blurring
                // it would spoil their own navigation. Movies inside opted-in collections
                // are already handled by the Movie-stub via IsMovieInSpoilerScope.

                // Season stub: for a Season of a guarded series with no watched episode
                // and not S0/S1, return an Id+Type stub so JE tag overlays don't render
                // on the blurred season poster. Mirrors the field-strip filter's Season
                // strip + the image filter's HasWatchedAnyEpisodeInSeason gate.
                if (spoilerStub == Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerTagDataStub.Season
                    && item is MediaBrowser.Controller.Entities.TV.Season spSeason)
                {
                    string? stubName = item.Name;
                    if (spReplaceTitle && spSeason.IndexNumber.HasValue)
                    {
                        stubName = $"Season {spSeason.IndexNumber.Value}";
                    }
                    var seasonFacts = TagDataEpisodeFacts(spSeason);
                    results.Add(new
                    {
                        Id = item.Id,
                        Type = kind.ToString(),
                        Genres = spStripGenres ? Array.Empty<string>() : (spSeason.Genres ?? Array.Empty<string>()),
                        CommunityRating = spStripRatings ? (float?)null : spSeason.CommunityRating,
                        CriticRating = spStripRatings ? (float?)null : spSeason.CriticRating,
                        Ratings = spStripRatings ? null : _tagCacheService.GetSourceRatings(spSeason),
                        Logos = spStripGenres ? null : _tagCacheService.GetLogos(spSeason),
                        OfficialRating = ResolveTagDataOfficialRating(spSeason, seriesOnly: spStripRatings),
                        LibraryId = TagDataLibraryId(spSeason),
                        CustomTags = spStripGenres ? null : TagDataCustomTags(spSeason),
                        Leaving = spStripGenres ? null : _tagCacheService.GetLeavingForUser(spSeason, user),
                        SeriesId = spStripRatings ? (Guid?)null : spSeason.SeriesId,
                        ProviderIds = default(IDictionary<string, string>),
                        Name = stubName,
                        RunTimeTicks = item.RunTimeTicks,
                        Path = (string?)null,
                        MediaStreams = (List<object>?)null,
                        MediaSources = (List<object>?)null,
                        FirstEpisode = (object?)null,
                        Tags = spStripGenres ? Array.Empty<string>() : (spSeason.Tags ?? Array.Empty<string>()),
                        DateCreated = Services.TagCacheService.ToUnixMilliseconds(spSeason.DateCreated),
                        LatestEpisodeAdded = seasonFacts.LatestAdded,
                        // Only the added span: air dates and numbers are what the
                        // premiere/finale badges read (the cache strip drops them too).
                        SeasonAddedSpan = seasonFacts.Facts?.AddedSpan,
                    });
                    continue;
                }

                // OPT-3: Only get media sources/streams for playable items (Movies, Episodes)
                // Series and Season are containers with no media files — skip the expensive call
                List<object>? trimmedStreams = null;
                List<object>? trimmedSources = null;
                var namingTags = new Shared.MediaTags.MediaNamingTags();
                string[]? subtitleLanguages = null;
                string[]? sdhSubtitleLanguages = null;
                if (!isContainer)
                {
                    var mediaSources =
                        SelectTagDataMediaSources(item.GetMediaSources(false));
                    namingTags = Shared.MediaTags.MediaNamingTags.Detect(item.Path, mediaSources, item.Name, item.OriginalTitle);
                    subtitleLanguages = TagDataSubtitleLanguages(mediaSources);
                    sdhSubtitleLanguages = mediaSources.SelectMany(source => source.MediaStreams ?? new List<MediaStream>())
                        .Where(stream => stream.Type == MediaStreamType.Subtitle && !stream.IsForced && SubtitleAccessibility.IsSdh(stream.IsHearingImpaired, stream.Title, stream.DisplayTitle))
                        .Select(stream => Services.TagCacheService.NormalizeStreamLanguage(stream.Language)).OfType<string>().Distinct(StringComparer.Ordinal).ToArray();
                    // OPT-5: Only include fields tag renderers need from MediaStreams
                    trimmedStreams = mediaSources
                        .SelectMany(source => MediaStreamLanguageResolver.Resolve(source, item.Path, _matroskaLanguageCache).Select(r => (SourceId: source.Id, Resolved: r)))
                        .Where(resolved =>
                            resolved.Resolved.Stream.Type == MediaStreamType.Video
                            || resolved.Resolved.Stream.Type == MediaStreamType.Audio
                            || (resolved.Resolved.Stream.Type == MediaStreamType.Subtitle && !resolved.Resolved.Stream.IsForced))
                        .Select(resolved =>
                        {
                            var s = resolved.Resolved.Stream;
                            return (object)new
                            {
                                Type = s.Type.ToString(),
                                SourceId = resolved.SourceId,
                                Language = resolved.Resolved.Language,
                                Codec = s.Codec,
                                CodecTag = s.CodecTag,
                                Profile = s.Profile,
                                Height = s.Height,
                                Width = s.Width,
                                AspectRatio = s.AspectRatio,
                                RealFrameRate = s.RealFrameRate,
                                AverageFrameRate = s.AverageFrameRate,
                                IsInterlaced = s.IsInterlaced,
                                IsHearingImpaired = s.IsHearingImpaired,
                                Title = s.Title,
                                Channels = s.Channels,
                                ChannelLayout = s.ChannelLayout,
                                VideoRangeType = s.VideoRangeType,
                                    VideoRange = s.Type == MediaStreamType.Video ? Shared.MediaTags.PosterTags.Resolution.QualityTagRules.CoarseRange(s.VideoRangeType.ToString(), s.VideoRange.ToString()) : null,
                                DisplayTitle = s.DisplayTitle,
                            };
                        })
                        .ToList();
                    // Include filenames only (not full paths) for IMAX/3D/media-stub detection.
                    // Full server paths are not exposed to avoid disclosing filesystem layout.
                    trimmedSources = mediaSources
                        .Select(s =>
                        {
                            var versionNaming = Shared.MediaTags.MediaNamingTags.Detect(item.Path, new[] { s }, item.Name, item.OriginalTitle);
                            return (object)new
                            {
                                Id = s.Id,
                                Source = versionNaming.Source,
                                Edition = versionNaming.Edition,
                                RunTimeTicks = s.RunTimeTicks,
                                Path = Shared.MediaTags.MediaNamingTags.FileName(s.Path),
                                Name = Shared.MediaTags.MediaNamingTags.FileName(s.Name),
                                Is3D = s.Video3DFormat != null ? true : (bool?)null,
                                Revision = Services.TagCacheService.MediaRevision(s),
                            };
                        })
                        .ToList();
                }

                // First episode lookup for Series/Season
                object? firstEpisodeData = null;
                if (isContainer)
                {
                    // Use the same stream-bearing episode as the server cache,
                    // retaining user access filters for this request-time lookup.
                    var epRef = TagEpisodeSelector.GetFirstEpisode(_libraryManager, item, user);
                    if (epRef != null)
                    {
                        // The frontend fetches this episode's region-aware stream
                        // projection from tag-data and shares it across renderers.
                        firstEpisodeData = new
                        {
                            Id = epRef.Id,
                            Type = epRef.GetBaseItemKind().ToString(),
                            Genres = epRef.Genres,
                            NeedsStreamFetch = true
                        };
                    }
                }

                var seriesId = (item is MediaBrowser.Controller.Entities.TV.Episode epItem) ? epItem.SeriesId
                             : (item is MediaBrowser.Controller.Entities.TV.Season sItem) ? sItem.SeriesId
                             : (Guid?)null;
                var episodeFacts = TagDataEpisodeFacts(item);

                results.Add(new
                {
                    Id = item.Id,
                    Type = kind.ToString(),
                    Genres = item.Genres,
                    CommunityRating = item.CommunityRating,
                    CriticRating = item.CriticRating,
                    Ratings = _tagCacheService.GetSourceRatings(item),
                    // Scores still on their way from MDBList: the browser re-asks soon instead of keeping this answer.
                    RatingsPending = _tagCacheService.SourceRatingsPending(item) ? true : (bool?)null,
                    // When these scores stop being current (Unix ms): a browser keeps this answer until then, not its own cache lifetime.
                    RatingsRefreshAt = _tagCacheService.SourceRatingsRefreshAt(item),
                    Awards = _tagCacheService.GetAwards(item),
                    Logos = _tagCacheService.GetLogos(item),
                    OfficialRating = ResolveTagDataOfficialRating(item),
                    LibraryId = TagDataLibraryId(item),
                    CustomTags = TagDataCustomTags(item),
                    Leaving = _tagCacheService.GetLeavingForUser(item, user),
                    SeriesId = seriesId,
                    ProviderIds = item.ProviderIds,
                    Name = item.Name,
                    RunTimeTicks = item.RunTimeTicks,
                    Path = Shared.MediaTags.MediaNamingTags.FileName(item.Path),
                    Source = namingTags.Source,
                    Edition = namingTags.Edition,
                    MediaStreams = trimmedStreams,
                    MediaSources = trimmedSources,
                    SubtitleLanguages = subtitleLanguages,
                    SdhSubtitleLanguages = sdhSubtitleLanguages,
                    Scenes = _tagCacheService.GetScenes(item),
                    FirstEpisode = firstEpisodeData,
                    QualitySummary = isContainer ? _tagCacheService.GetQualitySummaryForUser(item, user) : null,
                    DateCreated = Services.TagCacheService.ToUnixMilliseconds(item.DateCreated),
                    PremiereDate = TagDataPremiereDate(item),
                    LatestEpisodeAdded = episodeFacts.LatestAdded,
                    Status = TagDataSeriesStatus(item),
                    LatestEpisodeAired = episodeFacts.Facts?.LatestAired,
                    LatestEpisodeIndex = episodeFacts.Facts?.LatestIndex,
                    SeasonPremiere = episodeFacts.Facts?.SeasonPremiere,
                    SeasonAddedSpan = episodeFacts.Facts?.AddedSpan,
                    EpisodeIndex = latestEpisode && item is MediaBrowser.Controller.Entities.TV.Episode statusEpisode
                        ? _tagCacheService.BuildStatusEpisodeIndex(statusEpisode, user, out _) : null,
                    // Episodes: their numbers, for the premiere/finale badges.
                    IndexNumber = item is MediaBrowser.Controller.Entities.TV.Episode numbered ? numbered.IndexNumber : null,
                    ParentIndexNumber = item is MediaBrowser.Controller.Entities.TV.Episode numberedIn ? numberedIn.ParentIndexNumber : null,
                });
            }

            // What Hide tags stripped from these answers ("none": nothing). The web batch
            // fallback stamps what it keeps with it (SpoilerTagDataStripper.TagStripRevision).
            return Ok(new { Items = results, StripRevision = Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerTagDataStripper.TagStripRevision(spoilerPolicy) });
        }

        private UserSpoilerBlur? LoadSpoilerStateForTagStrip(Guid userId)
        {
            var userKey = userId.ToString("N");
            var fileName = Jellyfin.Plugin.JellyfinEnhanced.Features.SpoilerGuard.Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            if (!_userConfigurationManager.UserConfigurationExists(userKey, fileName))
            {
                return null;
            }
            try
            {
                return _userConfigurationManager.GetUserConfigurationStrict<UserSpoilerBlur>(userKey, fileName);
            }
            catch (InvalidDataException ex)
            {
                _spoilerResolver.WarnRateLimited(
                    "tagstrip-corrupt:" + userKey,
                    $"Spoiler Guard tag-strip: spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {ex.Message}");
                Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), ex.Message);
                return null;
            }
            catch (Newtonsoft.Json.JsonException ex)
            {
                _spoilerResolver.WarnRateLimited(
                    "tagstrip-corrupt:" + userKey,
                    $"Spoiler Guard tag-strip: spoilerblur.json corrupt for {_userDisplayResolver.ResolveUserDisplay(userKey)} (backed up): {ex.Message}");
                Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard.SpoilerUserResolver.RecordCorruption(userKey, _userDisplayResolver.ResolveUserDisplay(userKey), ex.Message);
                return null;
            }
            catch (IOException ex)
            {
                _spoilerResolver.WarnRateLimited(
                    "tagstrip-io:" + ex.GetType().FullName,
                    $"Spoiler Guard tag-strip: IO error reading state for {_userDisplayResolver.ResolveUserDisplay(userKey)}: {ex.Message}");
                return null;
            }
            catch (Exception ex)
            {
                // The specific catches above handle InvalidData/Json/IOException.
                // Others (UnauthorizedAccess from a chmod-mangled config dir, Security,
                // PathTooLong, DirectoryNotFound) would otherwise escape and 500 the whole
                // tag-cache/tag-data request, breaking every client's tag rail on every poll.
                // Catch-all returns null (skip strip) with rate-limited warn so a real
                // failure mode stays observable without taking down the unrelated surface.
                _spoilerResolver.WarnRateLimited(
                    "tagstrip-unexpected:" + ex.GetType().FullName,
                    $"Spoiler Guard tag-strip: unexpected {ex.GetType().Name} reading state for {_userDisplayResolver.ResolveUserDisplay(userKey)}: {ex.Message}");
                return null;
            }
        }
    }
}
