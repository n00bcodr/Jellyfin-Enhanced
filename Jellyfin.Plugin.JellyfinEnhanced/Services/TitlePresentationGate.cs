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
        }
        return result.Value;
    }

    /// <summary>Arrays and lists are already materialized; anything else is enumerated exactly once.</summary>
    private static IReadOnlyList<T> Once<T>(IEnumerable<T> values) => values is T[] or List<T> ? (IReadOnlyList<T>)values : values.ToArray();
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
        var read = HttpMethods.IsGet(context.HttpContext.Request.Method) || HttpMethods.IsHead(context.HttpContext.Request.Method);
        var viewer = UserHelper.GetCurrentUserId(context.HttpContext.User);
        if (viewer == null || viewer == Guid.Empty) return;
        // A guarded native endpoint (any verb: PlaybackInfo is also POSTed) is projected whatever shape it answers with.
        var guardedNative = HiddenContentResponseFilter.Guards(context) || SpoilerFieldStripFilter.Guards(context);
        var native = context.Result is ObjectResult { Value: not null } answer && (guardedNative && answer.StatusCode is null or (>= 200 and < 300)
            || read && answer.Value is BaseItemDto or QueryResult<BaseItemDto> or IEnumerable<BaseItemDto> or SearchHintResult);
        var route = read ? Route(context) : null;
        if (!native && route == null) return;
        try
        {
            var final = TitlePresentationGate.Read(manager, spoilers, viewer.Value, library);
            if (native)
            {
                DeliverNative(context, (ObjectResult)context.Result, final, route?.Surface, viewer.Value);
                return;
            }
            var spec = route!;
            var json = context.Result switch
            {
                ContentResult content when content.ContentType?.Contains("json", StringComparison.OrdinalIgnoreCase) == true => content.Content,
                FileContentResult file when file.ContentType.Contains("json", StringComparison.OrdinalIgnoreCase) => Encoding.UTF8.GetString(file.FileContents),
                ObjectResult obj when obj.StatusCode is null or 200 => JsonSerializer.Serialize(obj.Value, SerializerOptions(context.HttpContext)),
                _ => null
            };
            if (json == null) return;
            if (spec.Resource == "activity") json = ProjectActivity(json, final);
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

    private static JsonSerializerOptions SerializerOptions(HttpContext http)
        => (http.RequestServices?.GetService(typeof(Microsoft.Extensions.Options.IOptions<MvcOptions>)) as Microsoft.Extensions.Options.IOptions<MvcOptions>)?.Value.OutputFormatters
            .OfType<Microsoft.AspNetCore.Mvc.Formatters.SystemTextJsonOutputFormatter>().FirstOrDefault()?.SerializerOptions ?? new JsonSerializerOptions();

    private string ProjectActivity(string json, TitlePresentationPolicy final)
    {
        var root = JsonNode.Parse(json)!;
        var rows = (root["items"] ?? root["Items"]) as JsonArray;
        if (rows == null) return json;
        static JsonNode? Field(JsonNode row, string name) => row[name] ?? row[char.ToUpperInvariant(name[0]) + name[1..]];
        var ids = rows.OfType<JsonObject>().Select(r => Field(r, "item")).Where(i => i != null)
            .Select(i => Guid.TryParse(Field(i!, "id")?.ToString(), out var id) ? id : Guid.Empty).Where(id => id != Guid.Empty).Distinct().ToArray();
        var items = ids.Chunk(2000).SelectMany(batch => library.GetItemList(new InternalItemsQuery { ItemIds = batch })).ToDictionary(i => i.Id);
        var parents = items.Values.OfType<MediaBrowser.Controller.Entities.TV.Episode>().Select(e => e.SeriesId).Distinct().ToArray();
        foreach (var batch in parents.Chunk(2000)) foreach (var item in library.GetItemList(new InternalItemsQuery { ItemIds = batch })) items[item.Id] = item;
        for (var i = rows.Count - 1; i >= 0; i--)
        {
            if (rows[i] is not JsonObject row || Field(row, "item") is not JsonObject summary || !Guid.TryParse(Field(summary, "id")?.ToString(), out var id) || !items.TryGetValue(id, out var item)) continue;
            var parent = item is MediaBrowser.Controller.Entities.TV.Episode episode ? items.GetValueOrDefault(episode.SeriesId) : item;
            var key = HiddenContentPolicy.TitleIdentity(parent?.GetBaseItemKind().ToString(), parent?.GetProviderId(MetadataProvider.Tmdb));
            if (final.Hidden.IsHidden(key, id.ToString(), parent?.Id.ToString(), "library")) { rows.RemoveAt(i); continue; }
            foreach (var field in new[] { "content", "rating" })
                if (field == "content" ? final.Spoilers?.HidesReviews(key) == true : final.Spoilers?.HidesRatings(key) == true)
                { row.Remove(field); row.Remove(char.ToUpperInvariant(field[0]) + field[1..]); }
            if (final.Spoilers?.MissingRow(key).Title == true && item is MediaBrowser.Controller.Entities.TV.Episode)
            { summary.Remove("name"); summary.Remove("Name"); }
            if (final.Spoilers?.ProtectArtwork(key, item.GetBaseItemKind().ToString().ToLowerInvariant(), "Primary") == true)
                foreach (var field in new[] { "hasPrimaryImage", "hasThumbImage", "HasPrimaryImage", "HasThumbImage" }) if (summary[field] != null) summary[field] = false;
            var projected = JsonNode.Parse(ProviderPresentationSchema.Project(row.ToJsonString(), null, final.Spoilers, "library", key,
                "activity-row", item.GetBaseItemKind().ToString().ToLowerInvariant()));
            rows[i] = projected;
        }
        return root.ToJsonString();
    }

    /// <summary>
    /// Every response shape a guarded native endpoint returns (host-verified on 12.2 and 10.11.11), with the delivery-time
    /// policy: materialized once, those instances projected, and the projected value delivered.
    /// </summary>
    private void DeliverNative(ResultExecutingContext context, ObjectResult result, TitlePresentationPolicy final, string? surface, Guid viewer)
    {
        try
        {
            switch (NativeResponseValue.Materialize(result))
            {
                case BaseItemDto or QueryResult<BaseItemDto> or IEnumerable<BaseItemDto>:
                    ProjectNative(result, final, surface, viewer, context);
                    return;
                case SearchHintResult hints:
                    ProjectSearchHints(result, hints, final, surface, viewer, context);
                    return;
                case IReadOnlyList<RecommendationDto> recommendations:
                    ProjectRecommendations(recommendations, final, surface, viewer, context);
                    return;
                case IEnumerable<ImageInfo> or MediaBrowser.Model.MediaInfo.PlaybackInfoResponse:
                    StripDelivered(result, final, viewer, context);
                    return;
                default:
                    // An answer shape this gate cannot project never leaves while a policy applies to the viewer.
                    if (!PolicyApplies(final)) return;
                    logger?.Warning($"Presentation gate: {context.ActionDescriptor.DisplayName} answered {result.Value?.GetType().FullName}; withheld while a privacy policy applies.");
                    Withhold(context);
                    return;
            }
        }
        catch (Exception ex)
        {
            logger?.Error($"Presentation gate could not project {context.ActionDescriptor.DisplayName}: {ex.GetType().Name}");
            Withhold(context);
        }
    }

    private static void Withhold(ResultExecutingContext context)
    {
        context.Result = new StatusCodeResult(503);
        context.HttpContext.Response.Headers.CacheControl = "private, no-store";
    }

    private static bool PolicyApplies(TitlePresentationPolicy final)
        => !final.Hidden.IsEmpty || final.Spoilers is { Enabled: true } s && (s.Unavailable || SpoilerFieldStripFilter.HasEntries(s.State));

    /// <summary>Search hints carry no parent id: the owning series is read from the library, then hints are filtered like items.</summary>
    private void ProjectSearchHints(ObjectResult result, SearchHintResult page, TitlePresentationPolicy final, string? surface, Guid viewer, ResultExecutingContext context)
    {
        var hints = page.SearchHints.ToArray();
        if (!final.Hidden.IsEmpty && hints.Length > 0)
        {
            final.Hidden.BindLibraryIds(library, hints.Select(h => h.Id));
            var parents = new Dictionary<Guid, Guid>();
            var children = hints.Where(h => h.Type is BaseItemKind.Episode or BaseItemKind.Season).Select(h => h.Id).Distinct().ToArray();
            foreach (var batch in children.Chunk(2000))
                foreach (var item in library.GetItemList(new InternalItemsQuery { ItemIds = batch, DtoOptions = new MediaBrowser.Controller.Dto.DtoOptions(false) }) ?? [])
                    if (item is MediaBrowser.Controller.Entities.TV.Episode { SeriesId: var episodeSeries }) parents[item.Id] = episodeSeries;
                    else if (item is MediaBrowser.Controller.Entities.TV.Season { SeriesId: var seasonSeries }) parents[item.Id] = seasonSeries;
            var where = surface ?? HiddenContentResponseFilter.PresentationSurface(context, null);
            var kept = hints.Where(h => !final.Hidden.IsHidden(null, h.Id.ToString(), parents.TryGetValue(h.Id, out var series) ? series.ToString() : null, where)).ToArray();
            if (kept.Length != hints.Length) result.Value = new SearchHintResult(kept, Math.Max(0, page.TotalRecordCount - hints.Length + kept.Length));
        }
        StripDelivered(result, final, viewer, context);
    }

    /// <summary>Spoiler Guard's native strip, re-applied with the policy read at delivery; unknown policy is withheld.</summary>
    private void StripDelivered(ObjectResult result, TitlePresentationPolicy final, Guid viewer, ResultExecutingContext context)
    {
        if (final.Spoilers is not { Enabled: true } presentation) return;
        if (presentation.Unavailable) { Withhold(context); return; }
        strip?.StripDelivered(result, presentation.State, viewer, context);
    }

    private void ProjectNative(ObjectResult result, TitlePresentationPolicy final, string? surface, Guid viewer, ActionContext context)
    {
        var items = result.Value switch { BaseItemDto one => new[] { one }, QueryResult<BaseItemDto> page => page.Items.ToArray(), IEnumerable<BaseItemDto> list => list.ToArray(), _ => Array.Empty<BaseItemDto>() };
        var kept = ProjectItems(items, result.Value is BaseItemDto, final, surface, viewer, context);
        if (result.Value is QueryResult<BaseItemDto> query) result.Value = new QueryResult<BaseItemDto>(query.StartIndex, Math.Max(0, query.TotalRecordCount - items.Length + kept.Length), kept);
        else if (result.Value is not BaseItemDto) result.Value = kept;
    }

    /// <summary>Every category's items are projected in one batch; each category keeps its own projected items.</summary>
    private void ProjectRecommendations(IReadOnlyList<RecommendationDto> recommendations, TitlePresentationPolicy final, string? surface, Guid viewer, ActionContext context)
    {
        var items = recommendations.Where(r => r?.Items != null).SelectMany(r => r.Items).ToArray();
        var kept = ProjectItems(items, single: false, final, surface, viewer, context).ToHashSet(ReferenceEqualityComparer.Instance);
        foreach (var recommendation in recommendations)
            if (recommendation?.Items != null) recommendation.Items = recommendation.Items.Where(kept.Contains).ToArray();
    }

    /// <summary>
    /// Hidden Content and Spoiler Guard for materialized DTOs. A library item gets the full native rule set (Jellyfin ID,
    /// collection, provider and watched state) whether or not it carries TMDB metadata; an absent title is judged by
    /// its typed identity.
    /// </summary>
    private BaseItemDto[] ProjectItems(BaseItemDto[] items, bool single, TitlePresentationPolicy final, string? surface, Guid viewer, ActionContext context)
    {
        final.Hidden.BindLibraryIds(library, items.Select(i => i.Id));
        var real = items.Where(i => !SyntheticId.HasNamespace(i.Id)).ToArray();
        var identities = new Dictionary<Guid, string>();
        if (real.Length > 0 && JellyfinEnhanced.Instance?.Configuration.SpoilerBlurEnabled == true)
            foreach (var batch in real.SelectMany(i => i.SeriesId.HasValue ? new[] { i.Id, i.SeriesId.Value } : new[] { i.Id }).Distinct().Chunk(2000))
                foreach (var item in library.GetItemList(new InternalItemsQuery { ItemIds = batch, DtoOptions = new MediaBrowser.Controller.Dto.DtoOptions(false) { Fields = new[] { MediaBrowser.Model.Querying.ItemFields.ProviderIds } } }))
                    if (HiddenContentPolicy.TitleIdentity(item.GetBaseItemKind().ToString(), item.GetProviderId(MediaBrowser.Model.Entities.MetadataProvider.Tmdb)) is { } key) identities[item.Id] = key;
        string? Key(BaseItemDto dto) => SyntheticId.TryParse(dto.Id, host.SystemId, out var id) && id.IsTitle
            ? HiddenContentPolicy.TitleIdentity(id.IsMovie ? "movie" : "tv", id.TmdbId.ToString())
            : HiddenContentPolicy.TitleIdentity(dto.Type.ToString(), dto.ProviderIds?.FirstOrDefault(p => p.Key.Equals("Tmdb", StringComparison.OrdinalIgnoreCase)).Value)
                ?? identities.GetValueOrDefault(dto.SeriesId ?? dto.Id);
        string Surface(BaseItemDto item) => surface ?? HiddenContentResponseFilter.PresentationSurface(context, item);
        var kept = items.Where(i => single || !final.Hidden.IsHidden(Key(i), i.Id.ToString(), i.SeriesId?.ToString(), Surface(i)) && !final.Hidden.IsHidden(i, Surface(i))).ToArray();
        var config = JellyfinEnhanced.Instance?.Configuration;
        foreach (var dto in kept)
        {
            if (SyntheticId.HasNamespace(dto.Id))
            {
                var guarded = final.Spoilers?.Guarded(Key(dto)) == true;
                dto.ProviderIds ??= new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                dto.ProviderIds["JeSpoilerGuarded"] = guarded ? "true" : "false";
                if (guarded && final.Spoilers is { } absent && config != null) strip?.StripAbsent(dto, absent.State, config, viewer);
                continue;
            }
            if (final.Spoilers is not { Enabled: true } presentation || config == null) continue;
            // Unknown policy fails closed; otherwise the native strip decides from the item itself, never from a TMDB key.
            if (presentation.Unavailable) strip?.StripAbsent(dto, presentation.State, config, viewer);
            else if (SpoilerFieldStripFilter.HasEntries(presentation.State)) strip?.StripLibraryItem(dto, presentation.State, config, viewer);
        }
        return kept;
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
