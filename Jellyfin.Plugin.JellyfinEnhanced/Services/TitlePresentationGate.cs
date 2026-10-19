using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Search;
using Jellyfin.Data.Enums;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>The final synchronous presentation boundary. Never uses request-local policy snapshots.</summary>
public static class TitlePresentationGate
{
    /// <summary>Re-reads both policies under their mutation locks immediately before projection/delivery.</summary>
    public static TitlePresentationPolicy Read(UserConfigurationManager manager, SpoilerPresentation? spoilers, Guid viewer, ILibraryManager? library = null)
    {
        lock (manager.GetUserFileLock(viewer.ToString("N"), "hidden-content.json"))
        lock (manager.GetUserFileLock(viewer.ToString("N"), "spoilerblur.json"))
            return new(HiddenContentPolicy.Load(manager, viewer, library: library), spoilers?.Load(viewer));
    }
}

/// <summary>
/// Every response value a native endpoint answers with, enumerated exactly once. Hosts may answer with lazy sequences
/// that build fresh DTOs on each enumeration (12.2's movie recommendations are a Select over the categories); a
/// projection over one enumeration is lost on the next, so each owner projects the materialized instances and the
/// materialized value is what MVC serializes.
/// </summary>
public static class NativeResponseValue
{
    /// <summary>Replaces the result's value with its materialized equivalent (the same instances when already materialized) and returns it.</summary>
    public static object? Materialize(ObjectResult result)
    {
        switch (result.Value)
        {
            case QueryResult<BaseItemDto> page:
                if (page.Items != null) page.Items = Once(page.Items);
                break;
            case IEnumerable<BaseItemDto> list:
                result.Value = Once(list);
                break;
            case SearchHintResult hints when hints.SearchHints is not null && hints.SearchHints is not (SearchHint[] or List<SearchHint>):
                result.Value = new SearchHintResult(hints.SearchHints.ToArray(), hints.TotalRecordCount);
                break;
            case IEnumerable<RecommendationDto> recommendations:
                var once = Once(recommendations);
                foreach (var recommendation in once)
                    if (recommendation?.Items != null) recommendation.Items = Once(recommendation.Items);
                result.Value = once;
                break;
            case IEnumerable<ImageInfo> images:
                result.Value = Once(images);
                break;
            case MediaBrowser.Model.MediaInfo.PlaybackInfoResponse { MediaSources: not null } playback:
                playback.MediaSources = Once(playback.MediaSources);
                break;
            case AllThemeMediaResult all:
                foreach (var part in new[] { all.ThemeVideosResult, all.ThemeSongsResult, all.SoundtrackSongsResult })
                    if (part?.Items != null) part.Items = Once(part.Items);
                break;
        }
        return result.Value;
    }

    /// <summary>Arrays and lists are already materialized; anything else is enumerated exactly once.</summary>
    private static IReadOnlyList<T> Once<T>(IEnumerable<T> values) => values is T[] or List<T> ? (IReadOnlyList<T>)values : values.ToArray();
}

/// <summary>
/// The one Hidden Content projection over native answers, shared by the Hidden Content action filter and the final
/// delivery gate: items, search hints and recommendation categories are judged by the resolved library identity on the
/// surface each item is listed on; a recommendation category seeded by a hidden or guarded title is dropped with its
/// heading (person-seeded categories are kept).
/// </summary>
internal static class NativePrivacyProjection
{
    /// <summary>Every library id the answer names: items, hints, recommendation seeds, theme owners and nested title members.</summary>
    public static IEnumerable<Guid> Ids(object? value)
    {
        IEnumerable<Guid> top = value switch
        {
            SearchHintResult hints => hints.SearchHints?.Select(h => h.Id) ?? [],
            AllThemeMediaResult all => ThemeItems(all).Select(i => i.Id),
            IEnumerable<RecommendationDto> categories => categories.Where(r => r != null)
                .SelectMany(r => (r.Items ?? []).Select(i => i.Id).Append(Seed(r) ?? Guid.Empty)),
            _ => Items(value).Select(i => i.Id)
        };
        return top.Concat(Nested(value).Select(n => n.Dto.Id)).Concat(Timers(value).Select(t => ProgramOf(t) ?? Guid.Empty))
            .Concat(ActivityEntries(value).Select(e => ItemOf(e) ?? Guid.Empty));
    }

    /// <summary>The entries of an activity-log answer.</summary>
    public static IReadOnlyList<MediaBrowser.Model.Activity.ActivityLogEntry> ActivityEntries(object? value)
        => value is QueryResult<MediaBrowser.Model.Activity.ActivityLogEntry> { Items: not null } page ? page.Items.Where(e => e != null).ToArray() : [];

    /// <summary>The library item an activity entry records.</summary>
    public static Guid? ItemOf(MediaBrowser.Model.Activity.ActivityLogEntry entry) => Guid.TryParse(entry.ItemId, out var id) && id != Guid.Empty ? id : null;

    /// <summary>Whether the answer holds title members or title rows the gate projects besides its own items.</summary>
    public static bool HasTitleMembers(object? value) => Nested(value).Count > 0 || Timers(value).Count > 0 || ActivityEntries(value).Any(e => ItemOf(e) != null);

    /// <summary>
    /// The identities of every library item the answer names, from the one identity resolver (<paramref name="resolve"/>
    /// or the request-cached viewer-independent resolution). Ownership comes from the resolver and the host's own owner
    /// facts, never from a DTO's fields: a theme answer's OwnerId owns its items, and an endpoint that lists the opened
    /// item's extras (local trailers, special features) owns them by its route.
    /// </summary>
    public static Dictionary<Guid, PrivacyIdentity> Identities(ILibraryManager library, object? value, ActionContext? context,
        Func<IEnumerable<Guid>, Dictionary<Guid, PrivacyIdentity>>? resolve = null)
    {
        var owners = Owners(value, context);
        var ids = Ids(value).Concat(owners.Select(o => o.Owner)).Where(id => id != Guid.Empty && !SyntheticId.HasNamespace(id)).Distinct().ToArray();
        var identities = resolve?.Invoke(ids) ?? PrivacyIdentities.Resolve(library, ids, context?.HttpContext);
        foreach (var (owner, items) in owners)
        {
            if (!identities.TryGetValue(owner, out var title)) continue;
            foreach (var dto in items)
                if (dto != null && dto.Id != owner && (!identities.TryGetValue(dto.Id, out var own) || !own.IsExtra))
                    identities[dto.Id] = PrivacyIdentity.Owned(title, dto.Id, own?.Kind ?? dto.Type);
        }
        return identities;
    }

    /// <summary>The host's owner facts in the answer: each theme list's OwnerId, or the route's opened item for its extras.</summary>
    private static List<(Guid Owner, IReadOnlyList<BaseItemDto> Items)> Owners(object? value, ActionContext? context)
    {
        var owners = new List<(Guid, IReadOnlyList<BaseItemDto>)>();
        switch (value)
        {
            case ThemeMediaResult theme when theme.OwnerId != Guid.Empty && theme.Items != null:
                owners.Add((theme.OwnerId, theme.Items));
                break;
            case AllThemeMediaResult all:
                foreach (var part in new[] { all.ThemeVideosResult, all.ThemeSongsResult, all.SoundtrackSongsResult })
                    if (part is { Items: not null } && part.OwnerId != Guid.Empty) owners.Add((part.OwnerId, part.Items));
                break;
            case IEnumerable<BaseItemDto> extras when context != null && PrivacySurfaceRegistry.RouteOwnsAnswer(context) is { } opened:
                owners.Add((opened, extras.ToArray()));
                break;
        }
        return owners;
    }

    /// <summary>A title member nested inside an answer's own value, and how to replace it in the delivered value.</summary>
    public sealed record NestedTitle(BaseItemDto Dto, Action<BaseItemDto?> Replace, bool KeepsControls);

    /// <summary>
    /// The title members an answer carries besides its own items, as the hosts build them (12.2 and 10.11.11): a channel's
    /// CurrentProgram on any item, a session's NowPlayingItem (its controls hang on it), NowViewingItem and (10.11) queue
    /// items, and a timer's ProgramInfo. Replacing one never touches the host's shared session state.
    /// </summary>
    public static List<NestedTitle> Nested(object? value)
    {
        var found = new List<NestedTitle>();
        void Item(BaseItemDto? dto)
        {
            if (dto?.CurrentProgram is { } program) found.Add(new(program, v => dto.CurrentProgram = v, false));
        }
        void Session(SessionInfoDto? session)
        {
            if (session == null) return;
            if (session.NowPlayingItem is { } playing) found.Add(new(playing, v => session.NowPlayingItem = v, true));
            if (session.NowViewingItem is { } viewing) found.Add(new(viewing, v => session.NowViewingItem = v, false));
#if !JF12
            if (session.NowPlayingQueueFullItems is { Count: > 0 } queue)
            {
                // The session's own list is shared: the delivered value gets its own copy before an element is replaced.
                var own = queue.ToArray();
                session.NowPlayingQueueFullItems = own;
                for (var i = 0; i < own.Length; i++)
                {
                    var index = i;
                    if (own[i] != null) found.Add(new(own[i], v => own[index] = v!, true));
                }
            }
#endif
        }
        switch (value)
        {
            case IEnumerable<SessionInfoDto> sessions:
                foreach (var session in sessions) Session(session);
                break;
            case MediaBrowser.Model.LiveTv.TimerInfoDto or QueryResult<MediaBrowser.Model.LiveTv.TimerInfoDto>:
                foreach (var timer in Timers(value))
                    if (timer.ProgramInfo is { } program) found.Add(new(program, v => timer.ProgramInfo = v, false));
                break;
            case IEnumerable<RecommendationDto> categories:
                foreach (var category in categories) foreach (var item in category?.Items ?? []) Item(item);
                break;
            case AllThemeMediaResult all:
                foreach (var item in ThemeItems(all)) Item(item);
                break;
            default:
                foreach (var item in Items(value)) Item(item);
                break;
        }
        return found;
    }

    /// <summary>The timer rows of a timer answer.</summary>
    public static IReadOnlyList<MediaBrowser.Model.LiveTv.TimerInfoDto> Timers(object? value) => value switch
    {
        MediaBrowser.Model.LiveTv.TimerInfoDto one => [one],
        QueryResult<MediaBrowser.Model.LiveTv.TimerInfoDto> page => page.Items?.Where(t => t != null).ToArray() ?? [],
        _ => []
    };

    /// <summary>The library programme a timer records.</summary>
    public static Guid? ProgramOf(MediaBrowser.Model.LiveTv.TimerInfoDto timer)
        => Guid.TryParse(timer.ProgramId, out var id) ? id : timer.ProgramInfo?.Id;

    /// <summary>
    /// What a hidden now-playing (or queued) item leaves: enough for the session's controls (id, kind, length), no title.
    /// </summary>
    public static BaseItemDto Stub(BaseItemDto dto) => new()
    {
        Id = dto.Id, ServerId = dto.ServerId, Type = dto.Type, MediaType = dto.MediaType, IsFolder = dto.IsFolder,
        RunTimeTicks = dto.RunTimeTicks, LocationType = dto.LocationType, Name = string.Empty
    };

    /// <summary>A private copy of a DTO the host may share (a session's now-playing item), for projection.</summary>
    public static BaseItemDto Copy(BaseItemDto dto)
        => JsonSerializer.Deserialize<BaseItemDto>(JsonSerializer.SerializeToUtf8Bytes(dto, Jellyfin.Extensions.Json.JsonDefaults.Options), Jellyfin.Extensions.Json.JsonDefaults.Options)!;

    /// <summary>The DTOs of an item answer (single, page or list).</summary>
    public static IReadOnlyList<BaseItemDto> Items(object? value) => value switch
    {
        BaseItemDto one => [one],
        QueryResult<BaseItemDto> page => page.Items?.ToArray() ?? [],
        IEnumerable<BaseItemDto> list => list.ToArray(),
        _ => []
    };

    /// <summary>The items of the three theme lists an item's theme media answer holds.</summary>
    public static IReadOnlyList<BaseItemDto> ThemeItems(AllThemeMediaResult all)
        => new[] { all.ThemeVideosResult, all.ThemeSongsResult, all.SoundtrackSongsResult }.Where(r => r?.Items != null).SelectMany(r => r.Items).ToArray();

    /// <summary>A "because you watched / liked" category names its seed title by id; person categories name a person.</summary>
    public static Guid? Seed(RecommendationDto category)
        => category.RecommendationType is RecommendationType.SimilarToRecentlyPlayed or RecommendationType.SimilarToLikedItem
            && category.CategoryId != Guid.Empty ? category.CategoryId : null;

    /// <summary>
    /// Hides titles from a materialized answer (a new value when anything is removed). <paramref name="hide"/> null
    /// skips Hidden Content; <paramref name="seedGuarded"/> drops categories whose seed Spoiler Guard protects.
    /// </summary>
    public static void Hide(ObjectResult result, HiddenContentPolicy? hide, Func<BaseItemDto?, string> surface,
        IReadOnlyDictionary<Guid, PrivacyIdentity> identities, bool single, Func<Guid, bool>? seedGuarded = null)
    {
        bool Hidden(BaseItemDto dto) => hide != null && !single && hide.IsHidden(dto, identities.GetValueOrDefault(dto.Id), surface(dto));
        switch (result.Value)
        {
            case QueryResult<BaseItemDto> page when hide != null && page.Items != null:
                var kept = page.Items.Where(i => !Hidden(i)).ToList();
                // A new page: the action's answer may be a shared collection, and must not change.
                if (kept.Count != page.Items.Count)
                    result.Value = new QueryResult<BaseItemDto>(page.StartIndex, Math.Max(0, page.TotalRecordCount - page.Items.Count + kept.Count), kept);
                return;
            case IEnumerable<BaseItemDto> list when hide != null:
                var items = list.ToList();
                var shown = items.Where(i => !Hidden(i)).ToList();
                if (shown.Count != items.Count) result.Value = shown;
                return;
            case SearchHintResult hints when hide != null && hints.SearchHints is { Count: > 0 } all:
                var where = surface(null);
                var visible = all.Where(h => !hide.IsHidden(null, h.Id.ToString(), null, where)
                    && !(identities.TryGetValue(h.Id, out var identity) && hide.IsHidden(identity, where))).ToArray();
                if (visible.Length != all.Count) result.Value = new SearchHintResult(visible, Math.Max(0, hints.TotalRecordCount - all.Count + visible.Length));
                return;
            case IReadOnlyList<RecommendationDto> categories:
                var groups = new List<RecommendationDto>(categories.Count);
                foreach (var category in categories)
                {
                    if (category == null) continue;
                    if (Seed(category) is { } seed && (seedGuarded?.Invoke(seed) == true
                        || hide != null && identities.TryGetValue(seed, out var owner) && hide.IsHidden(owner, surface(null)))) continue;
                    var before = category.Items?.Count ?? 0;
                    if (category.Items != null && hide != null) category.Items = category.Items.Where(i => !Hidden(i)).ToArray();
                    if (before > 0 && category.Items?.Count == 0) continue;
                    groups.Add(category);
                }
                if (groups.Count != categories.Count) result.Value = groups;
                return;
        }
    }
}

/// <summary>Activity rows: the one schema projection, keyed by the row item's resolved identity.</summary>
internal static class ActivityRows
{
    /// <summary>Projects one row (its review/rating, the item's episode title and artwork flags) by the item's native decision.</summary>
    public static JsonNode Project(JsonObject row, JsonObject summary, PrivacyIdentity identity, SpoilerPresentationContext? spoilers)
    {
        if (spoilers is not { Enabled: true }) return row;
        var key = spoilers.Bind(identity);
        var kind = identity.Kind.ToString().ToLowerInvariant();
        foreach (var field in new[] { "content", "rating" })
            if (field == "content" ? spoilers.HidesReviews(key) : spoilers.HidesRatings(key))
            { row.Remove(field); row.Remove(char.ToUpperInvariant(field[0]) + field[1..]); }
        if (spoilers.MissingRow(key).Title && identity.Kind == BaseItemKind.Episode)
        { summary.Remove("name"); summary.Remove("Name"); }
        if (spoilers.ProtectArtwork(key, kind, "Primary"))
            foreach (var field in new[] { "hasPrimaryImage", "hasThumbImage", "HasPrimaryImage", "HasThumbImage" }) if (summary[field] != null) summary[field] = false;
        return JsonNode.Parse(ProviderPresentationSchema.Project(row.ToJsonString(), null, spoilers, "library", key, "activity-row", kind))!;
    }
}

/// <summary>A fresh pair of effective policies used without an intervening asynchronous operation.</summary>
public sealed record TitlePresentationPolicy(HiddenContentPolicy Hidden, SpoilerPresentationContext? Spoilers)
{
    /// <summary>Opaque identity for personalized inserts and validators.</summary>
    public string Revision => Hidden.Revision + "|" + Spoilers?.Revision;

    /// <summary>Known JSON schemas are projected from private bytes, including envelopes and seed headings.</summary>
    public string Project(string json, string surface, string? title, string resource, string? kind = null, string? scope = null, int season = 0, int episode = 0)
    {
        return ProviderPresentationSchema.Project(json, Hidden, Spoilers, surface, title, resource, kind, scope, season, episode);
    }
}

/// <summary>
/// Runs even for facade short circuits, after action awaits and immediately before result serialization. Which
/// responses it guards comes from the matched endpoint's metadata (controller/action, route template and bound values),
/// never from the request path's text; policy is always re-read here, at delivery.
/// </summary>
public sealed class TitlePresentationResultFilter(UserConfigurationManager manager, SpoilerPresentation spoilers, ILibraryManager library,
    MediaBrowser.Controller.IServerApplicationHost host, SpoilerFieldStripFilter strip, Logger? logger = null) : IAlwaysRunResultFilter, IResourceFilter, IOrderedFilter
{
    /// <inheritdoc />
    public int Order => int.MaxValue;

    private const string ConditionalHeader = "__JE_PRESENTATION_IF_NONE_MATCH";

    /// <inheritdoc />
    public void OnResourceExecuting(ResourceExecutingContext context)
    {
        if (Route(context) == null) return;
        // An action cannot answer 304 using bytes produced before the final policy read.
        context.HttpContext.Items[ConditionalHeader] = context.HttpContext.Request.Headers.IfNoneMatch.ToString();
        context.HttpContext.Request.Headers.Remove("If-None-Match");
    }

    /// <inheritdoc />
    public void OnResourceExecuted(ResourceExecutedContext context)
    {
        if (context.HttpContext.Items.TryGetValue(ConditionalHeader, out var value))
            context.HttpContext.Request.Headers.IfNoneMatch = value?.ToString();
    }

    /// <inheritdoc />
    public void OnResultExecuting(ResultExecutingContext context)
    {
        var read = PrivacySurfaceRegistry.IsRead(context.HttpContext);
        var viewer = UserHelper.GetCurrentUserId(context.HttpContext.User);
        if (viewer == null || viewer == Guid.Empty) return;
        // Native endpoints (any verb: PlaybackInfo is also POSTed) are classified by the one surface registry.
        var entry = PrivacySurfaceRegistry.Find(context);
        var answer = context.Result as ObjectResult;
        var delivered = answer is { Value: not null } && answer.StatusCode is null or (>= 200 and < 300);
        var route = read && entry == null ? Route(context) : null;
        // An endpoint exempt for its own items still projects the title members nested in its answer (and title rows).
        if (entry != null && (!delivered || entry.Exempt && !NativePrivacyProjection.HasTitleMembers(answer!.Value))) return;
        if (entry == null && route == null)
        {
            // A title-carrying answer from an endpoint the registry does not classify never leaves while a policy applies.
            if (!delivered || IsJellyfinEnhanced(context) || !PrivacySurfaceRegistry.CarriesTitles(answer!.Value!.GetType())) return;
        }
        try
        {
            var final = TitlePresentationGate.Read(manager, spoilers, viewer.Value, library);
            if (entry != null)
            {
                DeliverNative(context, answer!, final, entry, viewer.Value);
                return;
            }
            if (route == null)
            {
                if (!PolicyApplies(final)) return;
                WarnUnclassified(context, answer!.Value!);
                Withhold(context);
                return;
            }
            var spec = route;
            var json = context.Result switch
            {
                ContentResult content when content.ContentType?.Contains("json", StringComparison.OrdinalIgnoreCase) == true => content.Content,
                FileContentResult file when file.ContentType.Contains("json", StringComparison.OrdinalIgnoreCase) => Encoding.UTF8.GetString(file.FileContents),
                ObjectResult obj when obj.StatusCode is null or 200 => JsonSerializer.Serialize(obj.Value, SerializerOptions(context.HttpContext)),
                _ => null
            };
            if (json == null) return;
            if (spec.Resource == "activity") json = ProjectActivity(json, final, viewer.Value);
            var projected = final.Project(json, spec.Surface, spec.Title, spec.Resource, spec.Kind, spec.Scope, spec.Season, spec.Episode);
            var etag = TmdbResponseCache.ComputeETag(viewer.Value.ToString("N") + "|" + final.Revision + "|" + projected);
            var conditional = context.HttpContext.Items.TryGetValue(ConditionalHeader, out var original) ? original?.ToString() : context.HttpContext.Request.Headers.IfNoneMatch.ToString();
            context.Result = TmdbResponseCache.IfNoneMatchMatches(conditional, etag) ? new StatusCodeResult(304)
                : new ContentResult { Content = projected, ContentType = "application/json; charset=utf-8", StatusCode = 200 };
            context.HttpContext.Response.Headers.CacheControl = "private, no-cache";
            context.HttpContext.Response.Headers.ETag = etag;
            context.HttpContext.Response.Headers.Remove("Last-Modified");
        }
        catch (Exception ex) when (ex is System.IO.IOException or Newtonsoft.Json.JsonException or JsonException)
        {
            context.Result = new StatusCodeResult(503);
            context.HttpContext.Response.Headers.CacheControl = "private, no-store";
        }
    }

    private static bool IsJellyfinEnhanced(ActionContext context)
        => context.ActionDescriptor is ControllerActionDescriptor action && action.ControllerTypeInfo.Assembly == typeof(TitlePresentationResultFilter).Assembly;

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, DateTime> _warnedUnclassified = new(StringComparer.Ordinal);

    private void WarnUnclassified(ActionContext context, object value)
    {
        var name = context.ActionDescriptor.DisplayName ?? "?";
        var now = DateTime.UtcNow;
        if (_warnedUnclassified.AddOrUpdate(name, now, (_, last) => now - last >= TimeSpan.FromHours(1) ? now : last) != now) return;
        logger?.Warning($"Presentation gate: {name} answered titles ({value.GetType().Name}) but is not in the privacy surface registry; withheld while a privacy policy applies. Re-warns hourly.");
    }

    private static JsonSerializerOptions SerializerOptions(HttpContext http)
        => (http.RequestServices?.GetService(typeof(Microsoft.Extensions.Options.IOptions<MvcOptions>)) as Microsoft.Extensions.Options.IOptions<MvcOptions>)?.Value.OutputFormatters
            .OfType<Microsoft.AspNetCore.Mvc.Formatters.SystemTextJsonOutputFormatter>().FirstOrDefault()?.SerializerOptions ?? new JsonSerializerOptions();

    /// <summary>
    /// Activity rows: every row's item is judged by the one identity resolver (item, owning series, TMDB key, guarded
    /// collections, the viewer's watched state), then projected by the same schema projection as provider JSON.
    /// </summary>
    private string ProjectActivity(string json, TitlePresentationPolicy final, Guid viewer)
    {
        var root = JsonNode.Parse(json)!;
        var rows = (root["items"] ?? root["Items"]) as JsonArray;
        if (rows == null) return json;
        static JsonNode? Field(JsonNode row, string name) => row[name] ?? row[char.ToUpperInvariant(name[0]) + name[1..]];
        var ids = rows.OfType<JsonObject>().Select(r => Field(r, "item")).Where(i => i != null)
            .Select(i => Guid.TryParse(Field(i!, "id")?.ToString(), out var id) ? id : Guid.Empty).Where(id => id != Guid.Empty).Distinct().ToArray();
        var identities = spoilers.Resolve(ids, viewer, final.Spoilers);
        for (var i = rows.Count - 1; i >= 0; i--)
        {
            if (rows[i] is not JsonObject row || Field(row, "item") is not JsonObject summary || !Guid.TryParse(Field(summary, "id")?.ToString(), out var id)
                || !identities.TryGetValue(id, out var identity)) continue;
            if (final.Hidden.IsHidden(identity, "library")) { rows.RemoveAt(i); continue; }
            rows[i] = ActivityRows.Project(row, summary, identity, final.Spoilers);
        }
        return root.ToJsonString();
    }

    /// <summary>
    /// Every response shape a registered native endpoint returns (host-verified on 12.2 and 10.11.11), with the
    /// delivery-time policy: materialized once, those instances projected, and the projected value delivered.
    /// </summary>
    private void DeliverNative(ResultExecutingContext context, ObjectResult result, TitlePresentationPolicy final, PrivacySurface entry, Guid viewer)
    {
        try
        {
            var value = NativeResponseValue.Materialize(result);
            var hc = entry.Hc != null && !final.Hidden.IsEmpty;
            var sg = entry.Sg && final.Spoilers is { Enabled: true };
            string Surface(BaseItemDto? item) => entry.Hc == null ? "none" : PrivacySurfaceRegistry.Surface(context, item);
            var known = value is BaseItemDto or QueryResult<BaseItemDto> or IEnumerable<BaseItemDto> or SearchHintResult or IReadOnlyList<RecommendationDto>
                or IEnumerable<ImageInfo> or MediaBrowser.Model.MediaInfo.PlaybackInfoResponse or AllThemeMediaResult or IEnumerable<SessionInfoDto>
                or MediaBrowser.Model.LiveTv.TimerInfoDto or QueryResult<MediaBrowser.Model.LiveTv.TimerInfoDto>
                or QueryResult<MediaBrowser.Model.Activity.ActivityLogEntry>;
            if (!known)
            {
                // An answer shape this gate cannot project never leaves while a policy applies to the viewer.
                if (!PolicyApplies(final)) return;
                logger?.Warning($"Presentation gate: {context.ActionDescriptor.DisplayName} answered {value?.GetType().FullName}; withheld while a privacy policy applies.");
                Withhold(context);
                return;
            }
            // The viewer's watched state is read only where a decision needs it (a recommendation category's seed).
            var seeds = sg && value is IReadOnlyList<RecommendationDto> && SpoilerFieldStripFilter.HasEntries(final.Spoilers!.State);
            // Activity entries are judged with the viewer's own watched state (an episode the viewer has seen keeps its title).
            var rows = NativePrivacyProjection.ActivityEntries(value).Count > 0;
            var identities = Identities(context, value, final, seeds || rows ? viewer : Guid.Empty);
            foreach (var identity in identities.Values) final.Hidden.Bind(identity);
            NativePrivacyProjection.Hide(result, hc ? final.Hidden : null, Surface, identities, single: value is BaseItemDto,
                sg ? seed => identities.TryGetValue(seed, out var owner) && final.Spoilers!.Guarded(owner) : null);
            ProjectNested(result.Value, final, identities, viewer, entry.HcExempt == null ? null : PrivacySurfaceRegistry.OpenedItem(context, result.Value));
            if (rows) ProjectActivityLog(result, final, identities);
            if (!sg) return;
            switch (result.Value)
            {
                case BaseItemDto or QueryResult<BaseItemDto> or IEnumerable<BaseItemDto>:
                    StripItems(NativePrivacyProjection.Items(result.Value), final, identities, viewer);
                    return;
                case IReadOnlyList<RecommendationDto> recommendations:
                    StripItems(recommendations.Where(r => r?.Items != null).SelectMany(r => r.Items).ToArray(), final, identities, viewer);
                    return;
                case AllThemeMediaResult all:
                    StripItems(NativePrivacyProjection.ThemeItems(all), final, identities, viewer);
                    return;
                default:
                    StripDelivered(result, final, viewer, context);
                    return;
            }
        }
        catch (Exception ex)
        {
            logger?.Error($"Presentation gate could not project {context.ActionDescriptor.DisplayName}: {ex.GetType().Name}");
            Withhold(context);
        }
    }

    /// <summary>
    /// The identities of every library item the answer names (items, hints, seeds, theme owners, nested title members),
    /// plus absent titles. Without a viewer, the request's earlier resolution (the Hidden Content action filter's) is reused.
    /// </summary>
    private Dictionary<Guid, PrivacyIdentity> Identities(ActionContext? context, object? value, TitlePresentationPolicy final, Guid viewer)
    {
        var identities = NativePrivacyProjection.Identities(library, value, context,
            viewer == Guid.Empty ? null : ids => spoilers.Resolve(ids, viewer, final.Spoilers));
        foreach (var pair in Synthetic(value)) identities.TryAdd(pair.Key, pair.Value);
        return identities;
    }

    /// <summary>
    /// The title members nested in an answer, with the requesting viewer's delivery-time policy: a hidden one leaves (a
    /// now-playing or queued item keeps a title-less stub so its session's controls stay), a guarded one is stripped on a
    /// private copy with this viewer's watched state (never the session owner's). The opened item is never hidden from its own answer.
    /// </summary>
    private void ProjectNested(object? value, TitlePresentationPolicy final, IReadOnlyDictionary<Guid, PrivacyIdentity> identities, Guid viewer, Guid? opened)
    {
        var hc = !final.Hidden.IsEmpty;
        var spoiler = final.Spoilers is { Enabled: true } s && (s.Unavailable || SpoilerFieldStripFilter.HasEntries(s.State)) ? final.Spoilers : null;
        var config = JellyfinEnhanced.Instance?.Configuration;
        if (!hc && spoiler == null) return;
        if (hc)
            foreach (var timer in NativePrivacyProjection.Timers(value))
                if (NativePrivacyProjection.ProgramOf(timer) is { } program && program != opened
                    && final.Hidden.IsHidden(identities.TryGetValue(program, out var row) ? row : new PrivacyIdentity(program, BaseItemKind.Program, program, null, Array.Empty<Guid>(), null), "library"))
                {
                    // A hidden programme's timer row stays (it can still be cancelled) without the programme's title.
                    timer.Name = null; timer.Overview = null; timer.ProgramInfo = null;
                }
        foreach (var member in NativePrivacyProjection.Nested(value))
        {
            var identity = identities.GetValueOrDefault(member.Dto.Id);
            if (hc && member.Dto.Id != opened && final.Hidden.IsHidden(member.Dto, identity, "library"))
            {
                member.Replace(member.KeepsControls ? NativePrivacyProjection.Stub(member.Dto) : null);
                continue;
            }
            if (spoiler == null || config == null) continue;
            var copy = NativePrivacyProjection.Copy(member.Dto);
            // The decision is this viewer's: a session's item carries no (or another account's) watched state.
            copy.UserData = null;
            if (spoiler.Unavailable) strip?.StripAbsent(copy, spoiler.State, config, viewer);
            else strip?.StripLibraryItem(copy, identity, spoiler.State, config, viewer);
            member.Replace(copy);
        }
    }

    /// <summary>
    /// The administrator's activity log, by each entry's own item and the viewer's rules: an entry about a title the viewer
    /// hid is left out (the page's total follows); a guarded episode the viewer hasn't watched has its title replaced in the
    /// entry's text the way Spoiler Guard replaces it ("Season 1, Episode 2"). Entries without an item are unchanged.
    /// </summary>
    private void ProjectActivityLog(ObjectResult result, TitlePresentationPolicy final, IReadOnlyDictionary<Guid, PrivacyIdentity> identities)
    {
        if (result.Value is not QueryResult<MediaBrowser.Model.Activity.ActivityLogEntry> { Items: not null } page) return;
        var spoiler = final.Spoilers is { Enabled: true } s && (s.Unavailable || SpoilerFieldStripFilter.HasEntries(s.State)) ? final.Spoilers : null;
        var config = JellyfinEnhanced.Instance?.Configuration;
        var replace = spoiler != null && config != null && SpoilerFieldStripFilter.AbsentRowStrip(spoiler.State, config).Title;
        var kept = new List<MediaBrowser.Model.Activity.ActivityLogEntry>(page.Items.Count);
        foreach (var entry in page.Items)
        {
            if (entry == null) continue;
            var identity = NativePrivacyProjection.ItemOf(entry) is { } id ? identities.GetValueOrDefault(id) : null;
            if (identity != null && !final.Hidden.IsEmpty && final.Hidden.IsHidden(identity, "library")) continue;
            if (identity is { Kind: BaseItemKind.Episode } && replace && (spoiler!.Unavailable || spoiler.Guarded(identity))
                && library.GetItemById(identity.ItemId) is MediaBrowser.Controller.Entities.TV.Episode episode && !string.IsNullOrEmpty(episode.Name))
            {
                var label = episode.ParentIndexNumber is { } season && episode.IndexNumber is { } number ? $"Season {season}, Episode {number}" : "Episode";
                if (entry.Name != null) entry.Name = entry.Name.Replace(episode.Name, label, StringComparison.Ordinal);
                entry.ShortOverview = entry.ShortOverview?.Replace(episode.Name, label, StringComparison.Ordinal);
                entry.Overview = entry.Overview?.Replace(episode.Name, label, StringComparison.Ordinal);
            }
            kept.Add(entry);
        }
        if (kept.Count != page.Items.Count)
            result.Value = new QueryResult<MediaBrowser.Model.Activity.ActivityLogEntry>(page.StartIndex, Math.Max(0, page.TotalRecordCount - page.Items.Count + kept.Count), kept);
    }

    /// <summary>
    /// Sessions as a viewer receives them (the REST answer and the dashboard's WebSocket updates): every session and its
    /// controls stay; their title members are projected with that viewer's delivery-time policy. A policy that cannot be
    /// read leaves no title in them.
    /// </summary>
    /// <param name="sessions">The host's session answer (fresh DTOs; their now-playing items may be shared).</param>
    /// <param name="viewer">The receiving viewer.</param>
    public IReadOnlyList<SessionInfoDto> ProjectSessions(IEnumerable<SessionInfoDto> sessions, Guid viewer)
    {
        var list = sessions.ToList();
        if (viewer == Guid.Empty || list.Count == 0 || NativePrivacyProjection.Nested(list).Count == 0) return list;
        try
        {
            var final = TitlePresentationGate.Read(manager, spoilers, viewer, library);
            if (!PolicyApplies(final)) return list;
            var identities = Identities(null, list, final, Guid.Empty);
            foreach (var identity in identities.Values) final.Hidden.Bind(identity);
            ProjectNested(list, final, identities, viewer, null);
        }
        catch (Exception ex)
        {
            logger?.Error($"Presentation gate could not project sessions: {ex.GetType().Name}");
            foreach (var member in NativePrivacyProjection.Nested(list)) member.Replace(member.KeepsControls ? NativePrivacyProjection.Stub(member.Dto) : null);
        }
        return list;
    }

    /// <summary>Absent titles (the native details facade's synthetic ids) carry their typed TMDB identity in the id itself.</summary>
    private Dictionary<Guid, PrivacyIdentity> Synthetic(object? value)
    {
        var identities = new Dictionary<Guid, PrivacyIdentity>();
        foreach (var dto in NativePrivacyProjection.Items(value))
            foreach (var id in dto.SeriesId is { } series ? new[] { dto.Id, series } : new[] { dto.Id })
                if (!identities.ContainsKey(id) && SyntheticId.TryParse(id, host.SystemId, out var synthetic) && synthetic.IsTitle)
                    identities[id] = new PrivacyIdentity(id, dto.Id == id ? dto.Type : synthetic.IsMovie ? BaseItemKind.Movie : BaseItemKind.Series,
                        id, HiddenContentPolicy.TitleIdentity(synthetic.IsMovie ? "movie" : "tv", synthetic.TmdbId.ToString()), Array.Empty<Guid>(), null);
        return identities;
    }

    private static void Withhold(ResultExecutingContext context)
    {
        context.Result = new StatusCodeResult(503);
        context.HttpContext.Response.Headers.CacheControl = "private, no-store";
    }

    private static bool PolicyApplies(TitlePresentationPolicy final)
        => !final.Hidden.IsEmpty || final.Spoilers is { Enabled: true } s && (s.Unavailable || SpoilerFieldStripFilter.HasEntries(s.State));

    /// <summary>Spoiler Guard's native strip, re-applied with the policy read at delivery; unknown policy is withheld.</summary>
    private void StripDelivered(ObjectResult result, TitlePresentationPolicy final, Guid viewer, ResultExecutingContext context)
    {
        if (final.Spoilers is not { Enabled: true } presentation) return;
        if (presentation.Unavailable) { Withhold(context); return; }
        strip?.StripDelivered(result, presentation.State, viewer, context);
    }

    /// <summary>
    /// Spoiler Guard for materialized DTOs. A library item gets the full native rule set (Jellyfin ID, collection,
    /// provider and watched state) whether or not it carries TMDB metadata; an absent title is judged by its typed identity.
    /// </summary>
    private void StripItems(IReadOnlyList<BaseItemDto> items, TitlePresentationPolicy final, IReadOnlyDictionary<Guid, PrivacyIdentity> identities, Guid viewer)
    {
        var config = JellyfinEnhanced.Instance?.Configuration;
        if (final.Spoilers is not { Enabled: true } presentation || config == null) return;
        foreach (var dto in items)
        {
            if (SyntheticId.HasNamespace(dto.Id))
            {
                var key = identities.GetValueOrDefault(dto.Id)?.TitleKey ?? identities.GetValueOrDefault(dto.SeriesId ?? Guid.Empty)?.TitleKey
                    ?? HiddenContentPolicy.TitleIdentity(dto.Type.ToString(), dto.ProviderIds?.FirstOrDefault(p => p.Key.Equals("Tmdb", StringComparison.OrdinalIgnoreCase)).Value);
                var guarded = presentation.Guarded(key);
                dto.ProviderIds ??= new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                dto.ProviderIds["JeSpoilerGuarded"] = guarded ? "true" : "false";
                if (guarded) strip?.StripAbsent(dto, presentation.State, config, viewer);
                continue;
            }
            // Unknown policy fails closed; otherwise the native strip decides from the item's resolved identity, never from a TMDB key.
            if (presentation.Unavailable) strip?.StripAbsent(dto, presentation.State, config, viewer);
            else if (SpoilerFieldStripFilter.HasEntries(presentation.State)) strip?.StripLibraryItem(dto, identities.GetValueOrDefault(dto.Id), presentation.State, config, viewer);
        }
    }

    private sealed record Schema(string Surface, string? Title, string Resource, string? Kind = null, string? Scope = null, int Season = 0, int Episode = 0);

    /// <summary>
    /// The matched JE endpoint's route template with its bound values, all lower-cased (literals come from the
    /// declaration, values from model binding). Request casing and aliases therefore cannot change the classification, and a route whose family
    /// segment is a parameter (for example the page catch-all) is never a guarded feed.
    /// </summary>
    private static string[]? EndpointSegments(ActionContext context)
    {
        if (context.ActionDescriptor is not ControllerActionDescriptor action || action.AttributeRouteInfo?.Template is not { } template
            || action.ControllerTypeInfo.Assembly != typeof(TitlePresentationResultFilter).Assembly) return null;
        var parts = template.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 2 || !parts[0].Equals("JellyfinEnhanced", StringComparison.OrdinalIgnoreCase) || parts[1].Contains('{')) return null;
        var segments = new List<string>();
        foreach (var part in parts.Skip(1))
        {
            if (!(part.StartsWith('{') && part.EndsWith('}'))) { segments.Add(part.ToLowerInvariant()); continue; }
            var name = part[1..^1].TrimStart('*').Split(':', '=', '?')[0];
            if (context.RouteData.Values.TryGetValue(name, out var value) && value?.ToString() is { Length: > 0 } text)
                segments.AddRange(text.ToLowerInvariant().Split('/', StringSplitOptions.RemoveEmptyEntries));
        }
        return segments.ToArray();
    }

    private static Schema? Route(ActionContext context)
    {
        var http = context.HttpContext;
        if (EndpointSegments(context) is not { Length: > 0 } p) return null;
        string? kind = p.FirstOrDefault(v => v is "movie" or "tv");
        string? title = null;
        for (var i = 0; i + 1 < p.Length; i++)
            if (HiddenContentPolicy.OwningTitle(p[i], p[i + 1]) is { } key) { title = key; break; }
        var seasonAt = Array.IndexOf(p, "season"); var episodeAt = Array.IndexOf(p, "episode");
        var season = seasonAt >= 0 && seasonAt + 1 < p.Length && int.TryParse(p[seasonAt + 1], out var sn) ? sn : 0;
        var episode = episodeAt >= 0 && episodeAt + 1 < p.Length && int.TryParse(p[episodeAt + 1], out var en) ? en : 0;
        var scope = episodeAt >= 0 ? "episode" : seasonAt >= 0 ? "season" : kind;
        var resource = ProviderPresentationSchema.ProviderResource(string.Join('/', p.Skip(p[0] == "native-details" && p.Length > 1 && p[1] == "title" ? 2 : 1)));
        if (p.Length >= 2 && p[^2] == "watch" && p[^1] == "providers") resource = "watch/providers";
        resource = ProviderPresentationSchema.LookupResource(string.Join('/', p.Skip(1))) ?? resource;
        if (p[0] is "tmdb" or "jellyseerr" or "native-details")
        {
            if (p.Any(v => v is "keywords" or "genres") && title == null && !p.Contains("discover")) return null;
            var surface = p.Contains("search") ? "search" : p.Any(v => v is "related" or "recommendations" or "similar") ? "recommendations" : p.Contains("request") ? "requests" : "discovery";
            return new(surface, title, resource, kind, scope, season, episode);
        }
        if (p[0] is "awards" or "mdblist-ratings") return new("details", title, p[0] == "awards" ? "awards" : "ratings", kind);
        if (p[0] == "reviews") return new("details", title, p.Length == 2 && p[1] == "ratings" ? "review-ratings" : "user-reviews", kind);
        if (p[0] == "activity") return new("library", Title: null, Resource: "activity");
        if (p[0] == "arr" && p.Length == 2 && p[1] is "requests" or "calendar") return new(p[1], Title: null, Resource: p[1] == "calendar" ? "calendar" : "arr-requests");
        if (p[0] != "acquire" || p.Length < 2) return null;
        if (p[1] == "hub") return new("requests", Title: null, Resource: "requests-hub");
        if (p[1] is "discover" or "search") return new(p[1] == "search" ? "search" : "discovery", Title: null, Resource: "page");
        if (p[1] == "requests" && (p.Length == 2 || p[2] is "mine" or "season")) return http.Request.Query["view"] == "pending" ? null : new("requests", Title: null, Resource: p.Length > 2 && p[2] == "season" ? "season-rows" : p.Length > 2 && p[2] == "mine" ? "request-mine" : "request-ledger");
        if (p[1] == "requests" && p.Length == 3 && p[2] == "approvals") return new("requests", Title: null, Resource: "approvals");
        if (p[1] == "status" && (p.Length == 2 || p.Length == 4 && p[2] == "item")) return new("requests", Title: null, Resource: "status-page");
        if (p[1] == "notify" && p.Last() == "inbox") return new("requests", Title: null, Resource: "inbox");
        return null;
    }

    /// <inheritdoc />
    public void OnResultExecuted(ResultExecutedContext context) { }
}
