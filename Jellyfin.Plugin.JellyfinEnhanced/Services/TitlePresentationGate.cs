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

/// <summary>Runs even for facade short circuits, after action awaits and immediately before result serialization.</summary>
public sealed class TitlePresentationResultFilter(UserConfigurationManager manager, SpoilerPresentation spoilers, ILibraryManager library,
    MediaBrowser.Controller.IServerApplicationHost host, SpoilerFieldStripFilter strip) : IAlwaysRunResultFilter, IResourceFilter, IOrderedFilter
{
    /// <inheritdoc />
    public int Order => int.MaxValue;

    private const string ConditionalHeader = "__JE_PRESENTATION_IF_NONE_MATCH";

    /// <inheritdoc />
    public void OnResourceExecuting(ResourceExecutingContext context)
    {
        if (Route(context.HttpContext, context.ActionDescriptor as ControllerActionDescriptor) == null) return;
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
        if (!HttpMethods.IsGet(context.HttpContext.Request.Method) && !HttpMethods.IsHead(context.HttpContext.Request.Method)) return;
        var viewer = UserHelper.GetCurrentUserId(context.HttpContext.User);
        if (viewer == null || viewer == Guid.Empty) return;
        var native = context.Result is ObjectResult { Value: BaseItemDto or QueryResult<BaseItemDto> or IEnumerable<BaseItemDto> };
        var route = Route(context.HttpContext, context.ActionDescriptor as ControllerActionDescriptor);
        if (!native && route == null) return;
        try
        {
            var final = TitlePresentationGate.Read(manager, spoilers, viewer.Value, library);
            if (native)
            {
                ProjectNative((ObjectResult)context.Result, final, route?.Surface, viewer.Value, context);
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

    private void ProjectNative(ObjectResult result, TitlePresentationPolicy final, string? surface, Guid viewer, ActionContext context)
    {
        var items = result.Value switch { BaseItemDto one => new[] { one }, QueryResult<BaseItemDto> page => page.Items.ToArray(), IEnumerable<BaseItemDto> list => list.ToArray(), _ => Array.Empty<BaseItemDto>() };
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
        var kept = items.Where(i => result.Value is BaseItemDto || !final.Hidden.IsHidden(Key(i), i.Id.ToString(), i.SeriesId?.ToString(), Surface(i)) && !final.Hidden.IsHidden(i, Surface(i))).ToArray();
        foreach (var dto in kept)
        {
            var guarded = final.Spoilers?.Guarded(Key(dto)) == true;
            if (SyntheticId.HasNamespace(dto.Id))
            {
                dto.ProviderIds ??= new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                dto.ProviderIds["JeSpoilerGuarded"] = guarded ? "true" : "false";
            }
            if (guarded && final.Spoilers is { } presentation && JellyfinEnhanced.Instance?.Configuration is { } config)
            {
                if (SyntheticId.HasNamespace(dto.Id) || presentation.Unavailable)
                    strip.StripAbsent(dto, presentation.State, config, viewer);
                else strip.StripLibraryItem(dto, presentation.State, config, viewer);
            }
        }
        if (result.Value is QueryResult<BaseItemDto> query) result.Value = new QueryResult<BaseItemDto>(query.StartIndex, Math.Max(0, query.TotalRecordCount - items.Length + kept.Length), kept);
        else if (result.Value is not BaseItemDto) result.Value = kept;
    }

    private sealed record Schema(string Surface, string? Title, string Resource, string? Kind = null, string? Scope = null, int Season = 0, int Episode = 0);

    private static Schema? Route(HttpContext http, ControllerActionDescriptor? action)
    {
        var path = http.Request.Path.Value?.Trim('/').Split('/') ?? Array.Empty<string>();
        if (path.Length < 2 || !path[0].Equals("JellyfinEnhanced", StringComparison.OrdinalIgnoreCase)) return null;
        var p = path.Skip(1).ToArray();
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
