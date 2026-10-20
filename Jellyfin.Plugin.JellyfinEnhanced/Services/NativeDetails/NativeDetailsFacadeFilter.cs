#if JF12
using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>
    /// The native details facade (Jellyfin 12, web): answers jellyfin-web's details-page requests
    /// for synthetic GUIDs (<see cref="SyntheticId"/>) from public Seerr/TMDB data, with no library
    /// rows, user data, people, events or session messages. Registered first among JE's action
    /// filters (order -1000, after Jellyfin's own authorization): a request naming a synthetic id is
    /// answered here (or refused) and never reaches the native action or the other JE filters;
    /// every other request passes through untouched. See <see cref="NativeDetailsAllowlist"/>.
    /// </summary>
    public sealed class NativeDetailsFacadeFilter : IAsyncActionFilter
    {
        /// <summary>The filter order (runs before JE's other filters, which use the default 0).</summary>
        public const int Order = -1000;

        private const int MaxSplitIds = 200;
        private static readonly ConcurrentDictionary<Type, PropertyInfo[]> BodyProperties = new();

        private readonly IUserManager _users;
        private readonly ILibraryManager _library;
        private readonly IDtoService _dto;
        private readonly IServerApplicationHost _host;
        private readonly IServerConfigurationManager _serverConfig;
        private readonly INativeDetailsSource _source;
        private readonly NativeDetailsPolicy _policy;
        private readonly NativeDetailsArtwork _artwork;
        private readonly SeerrParentalFilter _parental;
        private readonly Configuration.UserConfigurationManager? _userConfig;
        private readonly SpoilerFieldStripFilter? _spoilerStrip;
        private readonly SpoilerUserResolver? _spoilerUsers;
        private readonly NativeDetailsLinks _links;
        private readonly SpoilerPresentation? _presentation;
        private readonly ImageBlurService? _imageBlur;

        /// <summary>Creates the facade.</summary>
        public NativeDetailsFacadeFilter(
            IUserManager users,
            ILibraryManager library,
            IDtoService dto,
            IServerApplicationHost host,
            IServerConfigurationManager serverConfig,
            INativeDetailsSource source,
            NativeDetailsPolicy policy,
            NativeDetailsArtwork artwork,
            SeerrParentalFilter parental,
            Configuration.UserConfigurationManager? userConfig = null,
            SpoilerFieldStripFilter? spoilerStrip = null,
            SpoilerUserResolver? spoilerUsers = null,
            NativeDetailsLinks? links = null, SpoilerPresentation? presentation = null, ImageBlurService? imageBlur = null)
        {
            _presentation = presentation;
            _imageBlur = imageBlur;
            _users = users;
            _library = library;
            _dto = dto;
            _host = host;
            _serverConfig = serverConfig;
            _source = source;
            _policy = policy;
            _artwork = artwork;
            _parental = parental;
            _userConfig = userConfig;
            _spoilerStrip = spoilerStrip;
            _spoilerUsers = spoilerUsers;
            _links = links ?? new NativeDetailsLinks(library);
        }

        /// <inheritdoc />
        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            var serverId = _host.SystemId;
            var hits = FindSynthetic(context, serverId);
            if (hits == null)
            {
                await next().ConfigureAwait(false);
                return;
            }

            var result = await AnswerAsync(context, hits, serverId).ConfigureAwait(false);
            if (result == null)
            {
                await next().ConfigureAwait(false);
                return;
            }

            // A busy answer says when to come back (the client waits at least that long).
            if (result is StatusCodeResult { StatusCode: StatusCodes.Status429TooManyRequests }) context.HttpContext.Response.Headers["Retry-After"] = "2";
            context.Result = result;
        }

        /// <summary>Every verified synthetic id in the action's arguments (null when there is none).</summary>
        /// <param name="context">The action context.</param>
        /// <param name="serverId">This server's id.</param>
        /// <returns>(argument name, id) pairs, or null.</returns>
        internal static List<(string Argument, SyntheticId Id)>? FindSynthetic(ActionExecutingContext context, string serverId)
        {
            List<(string, SyntheticId)>? hits = null;
            var body = !HttpMethods.IsGet(context.HttpContext.Request.Method) && !HttpMethods.IsHead(context.HttpContext.Request.Method);
            foreach (var (name, value) in context.ActionArguments)
            {
                Scan(name, value, serverId, body, ref hits);
            }

            return hits;
        }

        private static void Scan(string name, object? value, string serverId, bool deep, ref List<(string, SyntheticId)>? hits)
        {
            switch (value)
            {
                case null:
                    return;
                case Guid guid:
                    if (SyntheticId.HasNamespace(guid) && SyntheticId.TryParse(guid, serverId, out var id)) (hits ??= new()).Add((name, id));
                    return;
                case string text:
                    ScanText(name, text, serverId, ref hits);
                    return;
                case IEnumerable<Guid> guids:
                    foreach (var g in guids) Scan(name, g, serverId, false, ref hits);
                    return;
                case IDictionary<string, string> map:
                    foreach (var v in map.Values) ScanText(name, v, serverId, ref hits);
                    return;
                case IEnumerable<string> texts:
                    foreach (var t in texts.Take(MaxSplitIds)) ScanText(name, t, serverId, ref hits);
                    return;
                case IDictionary keyed:
                    // Id-keyed maps in bodies (Hidden Content's Items): a synthetic id must never become a stored key.
                    foreach (var key in keyed.Keys) ScanText(name, key as string, serverId, ref hits);
                    return;
            }

            var type = value.GetType();
            if (!deep || type.IsPrimitive || type.IsEnum || value is IEnumerable) return;
            foreach (var property in BodyProperties.GetOrAdd(type, Properties))
            {
                object? inner;
                try
                {
                    inner = property.GetValue(value);
                }
                catch (Exception)
                {
                    continue;
                }

                Scan(name + "." + property.Name, inner, serverId, false, ref hits);
            }
        }

        private static void ScanText(string name, string? text, string serverId, ref List<(string, SyntheticId)>? hits)
        {
            if (string.IsNullOrEmpty(text)) return;
            if (text.Length is 32 or 36)
            {
                if (SyntheticId.TryParse(text, serverId, out var id)) (hits ??= new()).Add((name, id));
                return;
            }

            if (text.Contains(',', StringComparison.Ordinal) && text.Length < 40 * MaxSplitIds)
            {
                foreach (var part in text.Split(',', MaxSplitIds, StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
                {
                    if (part.Length is 32 or 36 && SyntheticId.TryParse(part, serverId, out var id)) (hits ??= new()).Add((name, id));
                }
            }
        }

        private static PropertyInfo[] Properties(Type type)
            => type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Where(p => p.GetIndexParameters().Length == 0 && p.CanRead
                    && (p.PropertyType == typeof(Guid) || p.PropertyType == typeof(Guid?) || p.PropertyType == typeof(string)
                        || typeof(IEnumerable<Guid>).IsAssignableFrom(p.PropertyType) || typeof(IDictionary<string, string>).IsAssignableFrom(p.PropertyType)
                        || typeof(IEnumerable<string>).IsAssignableFrom(p.PropertyType) || typeof(IDictionary).IsAssignableFrom(p.PropertyType)))
                .ToArray();

        private async Task<IActionResult?> AnswerAsync(ActionExecutingContext context, List<(string Argument, SyntheticId Id)> hits, string serverId)
        {
            var http = context.HttpContext;
            var method = http.Request.Method;
            var descriptor = context.ActionDescriptor as ControllerActionDescriptor;
            var route = NativeDetailsAllowlist.Find(descriptor?.ControllerName, descriptor?.ActionName);
            if (route == null || !route.Methods.Contains(method, StringComparer.OrdinalIgnoreCase)) return Refuse(method);

            if (route.Answer == FacadeAnswer.Batch) return Batch(context, hits, serverId);

            // Every synthetic argument must be one this action takes ids in, of a kind it serves.
            if (hits.Any(h => !route.IdArguments.Contains(h.Argument, StringComparer.Ordinal) || !route.Kinds.Contains(h.Id.Kind))) return Refuse(method);
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!NativeDetailsPolicy.FeatureEnabled(config)) return Refuse(method);
            // JE's own routes check the page's viewer rules themselves (IAbsentTitlePages).
            if (route.Answer == FacadeAnswer.PassThrough) return null;

            var ct = http.RequestAborted;
            if (route.Answer == FacadeAnswer.Image) return await ImageAsync(context, hits[0].Id, serverId, ct).ConfigureAwait(false);

            var (viewer, refusal) = Viewer(context);
            if (viewer == null) return refusal;
            var primary = hits.FirstOrDefault(h => h.Argument == route.IdArguments[0]);
            var title = primary.Argument == null ? hits[0].Id : primary.Id;
            // A person's page and a genre, studio or network discovery page hold public data only: the viewer-level rule.
            var access = title.IsTitle
                ? await _policy.SeeAsync(viewer, title, ct).ConfigureAwait(false)
                : await _policy.SeeLinkedPageAsync(viewer, title, ct).ConfigureAwait(false);
            switch (access)
            {
                case NativeDetailsPolicy.Access.Refused:
                    return new NotFoundResult();
                case NativeDetailsPolicy.Access.Unknown:
                    // Seerr can't tell whether the viewer is linked right now: retryable, not a refusal.
                    return Unavailable();
            }

            var guid = title.ToGuid(serverId);
            // The DTO builder (and where its names lead) only for the answers that draw items.
            Task<NativeDetailsDtos> Dtos() => DtosAsync(viewer, serverId, ct, http);
            // Spoiler Guard composes here: JE's own strip and image filters never see these answers.
            Configuration.UserSpoilerBlur? Spoilers() => title.IsTitle ? Guarded(http, viewer, title) : null;
            switch (route.Answer)
            {
                case FacadeAnswer.Item:
                    // A real library item with this id (never expected) wins.
                    if (_library.GetItemById(guid) != null) return null;
                    if (!title.IsTitle) return await LinkedPageAsync(await Dtos().ConfigureAwait(false), viewer, title, ct).ConfigureAwait(false);
                    return Guard(Parents(await ItemAsync(await Dtos().ConfigureAwait(false), viewer, title, ct).ConfigureAwait(false), viewer, title), Spoilers(), viewer);
                case FacadeAnswer.ThemeMedia:
                    return Ok(new AllThemeMediaResult { ThemeSongsResult = Theme(guid), ThemeVideosResult = Theme(guid), SoundtrackSongsResult = Theme(guid) });
                case FacadeAnswer.ThemeResult:
                    return Ok(Theme(guid));
                case FacadeAnswer.EmptyQuery:
                    return Ok(new QueryResult<BaseItemDto>(0, 0, Array.Empty<BaseItemDto>()));
                case FacadeAnswer.EmptyArray:
                    return Ok(Array.Empty<BaseItemDto>());
                case FacadeAnswer.Ancestors:
                    return Library(Guard(await AncestorsAsync(context, await Dtos().ConfigureAwait(false), viewer, title, ct).ConfigureAwait(false), Spoilers(), viewer), context, viewer);
                case FacadeAnswer.Seasons:
                    return Library(Guard(await SeasonsAsync(context, await Dtos().ConfigureAwait(false), viewer, title, ct).ConfigureAwait(false), Spoilers(), viewer), context, viewer);
                case FacadeAnswer.Episodes:
                    return Library(Guard(await EpisodesAsync(context, await Dtos().ConfigureAwait(false), viewer, hits, ct).ConfigureAwait(false), Spoilers(), viewer), context, viewer);
                case FacadeAnswer.Similar:
                    return Library(await SimilarAsync(context, await Dtos().ConfigureAwait(false), viewer, title, ct).ConfigureAwait(false), context, viewer, "recommendations");
                default:
                    return Refuse(method);
            }
        }

        /// <summary>
        /// The effective viewer, identical to native: the caller must be a real, enabled Jellyfin
        /// user (never an API key or a token without a user, even with the administrator role); a
        /// route/query user id other than the caller's is allowed only for an administrator, and
        /// the target user's policy then applies.
        /// </summary>
        private (User? Viewer, IActionResult? Refusal) Viewer(ActionExecutingContext context)
        {
            var caller = ArrCaller.Human(context.HttpContext.User, _users);
            if (caller == null) return (null, new StatusCodeResult(StatusCodes.Status403Forbidden));
            var asked = context.ActionArguments.TryGetValue("userId", out var raw) ? raw as Guid? : null;
            if (asked is not { } target || target == Guid.Empty || target == caller.Id) return (caller, null);
            if (!caller.HasPermission(PermissionKind.IsAdministrator)) return (null, new StatusCodeResult(StatusCodes.Status403Forbidden));
            User? viewer;
            try
            {
                viewer = _users.GetUserById(target);
            }
            catch (Exception)
            {
                viewer = null;
            }

            return viewer == null || viewer.HasPermission(PermissionKind.IsDisabled) ? (null, new NotFoundResult()) : (viewer, null);
        }

        private async Task<NativeDetailsDtos> DtosAsync(User viewer, string serverId, CancellationToken ct, HttpContext http)
        {
            var code = _serverConfig.Configuration?.MetadataCountryCode;
            var region = string.IsNullOrWhiteSpace(code) ? "US" : code.Trim().ToUpperInvariant();
            var revision = _policy.Revision(viewer);
            var links = _links.For(viewer, revision, serverId, await DiscoveryAsync(viewer, ct).ConfigureAwait(false));
            return new NativeDetailsDtos(serverId, viewer.Id, revision, _artwork, region, links, _presentation?.Load(viewer.Id, http).Revision);
        }

        /// <summary>
        /// The discovery destinations the viewer gets, each behind its row's admin switch and Seerr. A
        /// genre, studio or network discovery page reads its titles through Jellyfin Enhanced's own Seerr
        /// key, filtered for the viewer (<see cref="NativeDetailsFeeds"/>), so it needs no Seerr account.
        /// A tag leads to the library's tag page, whose discovery row reads Seerr with the viewer's own
        /// account, or the same native feeds (by TMDB keyword) for a viewer without one, so it needs
        /// none either.
        /// </summary>
        private Task<LinkDiscovery> DiscoveryAsync(User viewer, CancellationToken ct)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !NativeDetailsPolicy.SeerrConfigured(config)) return Task.FromResult(LinkDiscovery.None);
            return Task.FromResult(new LinkDiscovery(config.JellyseerrShowGenreDiscovery, config.JellyseerrShowNetworkDiscovery, config.JellyseerrShowTagDiscovery));
        }

        /// <summary>
        /// A page a title links to that isn't a title: a person (Seerr's person details; an adult performer
        /// is refused to a viewer with a parental limit) or a genre, studio or network discovery page (its name).
        /// </summary>
        private async Task<IActionResult> LinkedPageAsync(NativeDetailsDtos dtos, User viewer, SyntheticId page, CancellationToken ct)
        {
            switch (page.Kind)
            {
                case SyntheticKind.Person:
                    var person = await _source.PersonAsync(page.TmdbId, viewer.Id, ct).ConfigureAwait(false);
                    if (person.Data is not { } p) return Failed(person);
                    return NativeDetailsPolicy.PersonAllowed(viewer, p) ? Ok(dtos.Person(page, p)) : new NotFoundResult();
                case SyntheticKind.Genre:
                    var movie = await _source.GenresAsync(true, ct).ConfigureAwait(false);
                    var tv = await _source.GenresAsync(false, ct).ConfigureAwait(false);
                    var genre = GenreName(movie, page.TmdbId) ?? GenreName(tv, page.TmdbId);
                    if (genre != null) return Ok(dtos.NamePage(page, genre));
                    // Not in a list that answered: unknown; a list that couldn't be read: retryable.
                    return movie.Data == null || tv.Data == null ? Unavailable() : new NotFoundResult();
                case SyntheticKind.Studio:
                case SyntheticKind.Network:
                    var named = page.Kind == SyntheticKind.Studio
                        ? await _source.StudioAsync(page.TmdbId, viewer.Id, ct).ConfigureAwait(false)
                        : await _source.NetworkAsync(page.TmdbId, viewer.Id, ct).ConfigureAwait(false);
                    if (named.Data is not { } n) return Failed(named);
                    return NativeDetailsDtos.Str(n, "name") is { Length: > 0 } name ? Ok(dtos.NamePage(page, name.Trim())) : new NotFoundResult();
                default:
                    return new NotFoundResult();
            }
        }

        /// <summary>The name of a genre in a TMDB genre list (id, name), or null.</summary>
        private static string? GenreName(SourceAnswer list, int id)
        {
            if (list.Data is not { ValueKind: JsonValueKind.Array } genres) return null;
            foreach (var g in genres.EnumerateArray())
            {
                if (NativeDetailsDtos.Int(g, "id") == id && NativeDetailsDtos.Str(g, "name") is { Length: > 0 } name) return name.Trim();
            }

            return null;
        }

        /// <summary>
        /// A season or episode page of a series the viewer can open in the library (this season or episode
        /// isn't in it): its series (and, for an episode, its season when the viewer can open it) are the
        /// library's own, so the page's links go there rather than to stand-ins from public data.
        /// </summary>
        private IActionResult Parents(IActionResult result, User viewer, SyntheticId title)
        {
            if (title.Kind is not (SyntheticKind.Season or SyntheticKind.Episode) || result is not OkObjectResult { Value: BaseItemDto dto }) return result;
            var physical = _policy.Physical(viewer, false, title.TmdbId, null);
            if (physical.Shown.Count == 0) return result;
            var series = physical.Shown[0];
            dto.SeriesId = series;
            if (title.Kind == SyntheticKind.Season)
            {
                dto.ParentId = series;
            }
            else if (physical.VisibleSeasons.TryGetValue(title.Season, out var season))
            {
                dto.SeasonId = season;
                dto.ParentId = season;
            }

            return result;
        }

        private async Task<IActionResult> ItemAsync(NativeDetailsDtos dtos, User viewer, SyntheticId title, CancellationToken ct)
        {
            var logo = _source.LogoPathAsync(title.IsMovie, title.TmdbId, ct);
            if (title.IsMovie)
            {
                var movie = await _source.MovieAsync(title.TmdbId, viewer.Id, ct).ConfigureAwait(false);
                return movie.Data is { } m ? Ok(dtos.Movie(title, m, await logo.ConfigureAwait(false))) : Failed(movie);
            }

            var series = await _source.SeriesAsync(title.TmdbId, viewer.Id, ct).ConfigureAwait(false);
            if (series.Data is not { } s) return Failed(series);
            switch (title.Kind)
            {
                case SyntheticKind.Series:
                    return Ok(dtos.Series(title, s, await logo.ConfigureAwait(false)));
                case SyntheticKind.Season:
                    var summary = NativeDetailsDtos.Seasons(s).FirstOrDefault(e => NativeDetailsDtos.Int(e, "seasonNumber") == title.Season);
                    if (summary.ValueKind != JsonValueKind.Object) return new NotFoundResult();
                    // The page's episode list and status need the season's own data: when it can't be had, the
                    // page fails up front (retryable, the modal once) instead of showing a season with no episodes.
                    var seasonData = await _source.SeasonAsync(title.TmdbId, title.Season, viewer.Id, ct).ConfigureAwait(false);
                    if (seasonData.Data == null) return Failed(seasonData);
                    return Ok(dtos.WithSeriesNames(dtos.Season(title, s, summary, await logo.ConfigureAwait(false)), s));
                case SyntheticKind.Episode:
                    var season = await _source.SeasonAsync(title.TmdbId, title.Season, viewer.Id, ct).ConfigureAwait(false);
                    if (season.Data is not { } se) return Failed(season);
                    var episode = NativeDetailsDtos.Episodes(se).FirstOrDefault(e => NativeDetailsDtos.Int(e, "episodeNumber") == title.Episode);
                    return episode.ValueKind == JsonValueKind.Object ? Ok(dtos.WithSeriesNames(dtos.Episode(title, s, se, episode, await logo.ConfigureAwait(false)), s)) : new NotFoundResult();
                default:
                    return new NotFoundResult();
            }
        }

        private async Task<IActionResult> AncestorsAsync(ActionExecutingContext context, NativeDetailsDtos dtos, User viewer, SyntheticId title, CancellationToken ct)
        {
            if (title.Kind is not (SyntheticKind.Season or SyntheticKind.Episode)) return Ok(Array.Empty<BaseItemDto>());
            var series = await _source.SeriesAsync(title.TmdbId, viewer.Id, ct).ConfigureAwait(false);
            if (series.Data is not { } s) return Failed(series);
            var logo = await _source.LogoPathAsync(false, title.TmdbId, ct).ConfigureAwait(false);
            // The parts the viewer can open in the library are themselves (a season of a series Jellyfin has
            // but this season isn't in it), never a stand-in from public data.
            var physical = _policy.Physical(viewer, false, title.TmdbId, null);
            var options = Options(context);
            var list = new List<BaseItemDto>();
            if (title.Kind == SyntheticKind.Episode)
            {
                if (Real(physical.VisibleSeasons.TryGetValue(title.Season, out var held) ? held : null, viewer, options) is { } real) list.Add(real);
                else
                {
                    var summary = NativeDetailsDtos.Seasons(s).FirstOrDefault(e => NativeDetailsDtos.Int(e, "seasonNumber") == title.Season);
                    if (summary.ValueKind == JsonValueKind.Object) list.Add(dtos.Season(title.SeasonId, s, summary, logo));
                }
            }

            list.Add(Real(physical.Shown.Count > 0 ? physical.Shown[0] : null, viewer, options) ?? dtos.Series(title.SeriesId, s, logo));
            return Ok(list);
        }

        /// <summary>The fields a native list request asked for (native builds its DTOs with exactly those).</summary>
        private static DtoOptions Options(ActionExecutingContext context)
            => new() { Fields = Arg<ItemFields[]>(context, "fields") ?? Array.Empty<ItemFields>() };

        /// <summary>The library item's own DTO when the viewer can open it (Jellyfin's check for them), else null.</summary>
        private BaseItemDto? Real(Guid? id, User viewer, DtoOptions options)
            => id is Guid item && _library.GetItemById<BaseItem>(item, viewer) is { } found ? _dto.GetBaseItemDto(found, options, viewer) : null;

        private async Task<IActionResult> SeasonsAsync(ActionExecutingContext context, NativeDetailsDtos dtos, User viewer, SyntheticId series, CancellationToken ct)
        {
            if (Arg<bool?>(context, "isMissing") == false) return Ok(new QueryResult<BaseItemDto>(0, 0, Array.Empty<BaseItemDto>()));
            var data = await _source.SeriesAsync(series.TmdbId, viewer.Id, ct).ConfigureAwait(false);
            if (data.Data is not { } s) return Failed(data);
            var logo = await _source.LogoPathAsync(false, series.TmdbId, ct).ConfigureAwait(false);
            var special = Arg<bool?>(context, "isSpecialSeason");
            // A season the library has but hides from this viewer is never drawn from public data instead.
            var physical = _policy.Physical(viewer, false, series.TmdbId, null);
            var hidden = physical.HiddenSeasons;
            var options = Options(context);
            // A season the viewer can open in the library is listed as itself.
            var items = NativeDetailsDtos.Seasons(s)
                .Where(e => special == null || (NativeDetailsDtos.Int(e, "seasonNumber") == 0) == special)
                .Where(e => !hidden.Contains(NativeDetailsDtos.Int(e, "seasonNumber") ?? 0))
                .Select(e => NativeDetailsDtos.Int(e, "seasonNumber") ?? 0)
                .Select(n => Real(physical.VisibleSeasons.TryGetValue(n, out var held) ? held : null, viewer, options)
                    ?? dtos.Season(SyntheticId.SeasonOf(series.TmdbId, n), s, NativeDetailsDtos.Seasons(s).First(e => (NativeDetailsDtos.Int(e, "seasonNumber") ?? 0) == n), logo))
                .ToArray();
            return Ok(new QueryResult<BaseItemDto>(0, items.Length, items));
        }

        private async Task<IActionResult> EpisodesAsync(ActionExecutingContext context, NativeDetailsDtos dtos, User viewer, List<(string Argument, SyntheticId Id)> hits, CancellationToken ct)
        {
            var empty = Ok(new QueryResult<BaseItemDto>(0, 0, Array.Empty<BaseItemDto>()));
            var series = hits.FirstOrDefault(h => h.Argument == "seriesId");
            var seasonHit = hits.FirstOrDefault(h => h.Argument == "seasonId");
            // A season page of a series the library has (this season isn't in it) names the library's series:
            // the scope is that title when the series id is a copy of it the viewer can open.
            if (series.Argument == null && seasonHit.Argument != null && seasonHit.Id.Kind == SyntheticKind.Season
                && Arg<Guid?>(context, "seriesId") is { } realSeries && _policy.Physical(viewer, false, seasonHit.Id.TmdbId, null).Shown.Contains(realSeries))
            {
                series = ("seriesId", SyntheticId.Series(seasonHit.Id.TmdbId));
            }

            if (series.Argument == null || series.Id.Kind != SyntheticKind.Series) return new NotFoundResult();
            if (seasonHit.Argument != null && (seasonHit.Id.Kind != SyntheticKind.Season || seasonHit.Id.TmdbId != series.Id.TmdbId)) return new NotFoundResult();
            // A real season/series id next to a synthetic one is a mismatched scope.
            if (seasonHit.Argument == null && Arg<Guid?>(context, "seasonId") is { } other && other != Guid.Empty) return new NotFoundResult();
            var number = seasonHit.Argument != null ? seasonHit.Id.Season : Arg<int?>(context, "season");
            // Nothing playable: playback queues (isMissing=false, startItemId, adjacentTo) get nothing.
            if (number == null || Arg<bool?>(context, "isMissing") == false || Arg<Guid?>(context, "startItemId") is { } s1 && s1 != Guid.Empty
                || Arg<Guid?>(context, "adjacentTo") is { } a && a != Guid.Empty)
            {
                return empty;
            }

            // Missing episode rows follow the viewer's "Display missing episodes" setting, as native rows do.
            if (!viewer.DisplayMissingEpisodes) return empty;
            var seriesData = await _source.SeriesAsync(series.Id.TmdbId, viewer.Id, ct).ConfigureAwait(false);
            if (seriesData.Data is not { } sd) return Failed(seriesData);
            // A season the series doesn't have is unknown (404); a season whose episode list can't be
            // had right now is an empty list: jellyfin-web's episode list has no error handler.
            if (!NativeDetailsDtos.Seasons(sd).Any(e => NativeDetailsDtos.Int(e, "seasonNumber") == number.Value)) return new NotFoundResult();
            // The library's own season and episodes the viewer may not see are never drawn from public data:
            // a hidden season is unknown, a hidden episode has no row.
            var physical = _policy.Physical(viewer, false, series.Id.TmdbId, number.Value);
            if (physical.Hidden || physical.HiddenSeasons.Contains(number.Value)) return new NotFoundResult();
            var seasonData = await _source.SeasonAsync(series.Id.TmdbId, number.Value, viewer.Id, ct).ConfigureAwait(false);
            if (seasonData.Data is not { } se) return empty;
            var logo = await _source.LogoPathAsync(false, series.Id.TmdbId, ct).ConfigureAwait(false);
            var options = Options(context);
            // An episode the viewer can open in the library is listed as itself; a file holding several episodes
            // (E01-E02) once, at its first, with no stand-in for the others it holds.
            var listed = new HashSet<Guid>();
            var all = NativeDetailsDtos.Episodes(se)
                .Where(e => !physical.HiddenEpisodes.Contains(NativeDetailsDtos.Int(e, "episodeNumber") ?? 0))
                .Select(e =>
                {
                    var episode = NativeDetailsDtos.Int(e, "episodeNumber") ?? 0;
                    if (physical.VisibleEpisodes.TryGetValue(episode, out var held))
                    {
                        if (listed.Contains(held)) return null;
                        if (Real(held, viewer, options) is { } real)
                        {
                            listed.Add(held);
                            return real;
                        }
                    }
                    return dtos.Episode(SyntheticId.EpisodeOf(series.Id.TmdbId, number.Value, episode), sd, se, e, logo);
                })
                .OfType<BaseItemDto>()
                .ToArray();
            var start = Math.Max(0, Arg<int?>(context, "startIndex") ?? 0);
            var limit = Arg<int?>(context, "limit") is int l && l > 0 ? l : int.MaxValue;
            return Ok(new QueryResult<BaseItemDto>(start, all.Length, all.Skip(start).Take(limit).ToArray()));
        }

        private async Task<IActionResult> SimilarAsync(ActionExecutingContext context, NativeDetailsDtos dtos, User viewer, SyntheticId title, CancellationToken ct)
        {
            var limit = Math.Clamp(Arg<int?>(context, "limit") ?? 12, 1, 50);
            // Native builds the Similar DTOs with exactly the requested fields (LibraryController.GetSimilarItems).
            var options = new DtoOptions { Fields = Arg<ItemFields[]>(context, "fields") ?? Array.Empty<ItemFields>() };
            var data = await _source.RecommendationsAsync(title.IsMovie, title.TmdbId, ct).ConfigureAwait(false);
            if (data is not { } d) return Ok(new QueryResult<BaseItemDto>(0, 0, Array.Empty<BaseItemDto>()));
            // Parental filtering happens before paging and totals.
            var path = $"/api/v1/{(title.IsMovie ? "movie" : "tv")}/{title.TmdbId}/recommendations?page=1";
            var filtered = await _parental.ApplyAsync(d.GetRawText(), path, viewer.Id.ToString("N"), ct).ConfigureAwait(false);
            if (filtered.Block) return Ok(new QueryResult<BaseItemDto>(0, 0, Array.Empty<BaseItemDto>()));
            using var doc = JsonDocument.Parse(filtered.Body);
            var items = new List<BaseItemDto>();
            // Titles the viewer hid with Hidden Content stay out of this rail, as out of JE's recommendation rows:
            // before the limit, the total and any artwork grant.
            var hidden = _userConfig == null ? HiddenContentPolicy.Build(null) : HiddenContentPolicy.Load(_userConfig, viewer.Id, context.HttpContext, _library);
            if (doc.RootElement.TryGetProperty("results", out var results) && results.ValueKind == JsonValueKind.Array)
            {
                foreach (var r in results.EnumerateArray())
                {
                    if (items.Count >= limit) break;
                    var media = NativeDetailsDtos.Obj(r, "mediaInfo");
                    var key = HiddenContentPolicy.TitleIdentity(NativeDetailsDtos.Str(r, "mediaType"), NativeDetailsDtos.Int(r, "id")?.ToString());
                    if (hidden.IsHidden(key, NativeDetailsDtos.Str(media, "jellyfinMediaId"), null, "recommendations")
                        || hidden.IsHidden(key, NativeDetailsDtos.Str(media, "jellyfinMediaId4k"), null, "recommendations")) continue;
                    if (NativeDetailsDtos.Str(media, "jellyfinMediaId") is { } jf && Guid.TryParse(jf, out var real))
                    {
                        // A library copy is shown only when native would show it to this viewer (the user-scoped
                        // lookup checks parental rules, the parent chain and library access), with the fields the
                        // request asked for; never a synthetic stand-in for it.
                        var item = _library.GetItemById<BaseItem>(real, viewer);
                        if (item != null) { var own = _dto.GetBaseItemDto(item, options, viewer); if (!hidden.IsHidden(own, "recommendations")) items.Add(own); }
                        continue;
                    }

                    // A copy Seerr doesn't name but the library has (found by TMDB id): that copy when the viewer
                    // can open it, left out when it's hidden from them; an absent title only when its own page
                    // would open for this viewer.
                    var tmdb = NativeDetailsDtos.Int(r, "id") ?? 0;
                    var kind = NativeDetailsDtos.Str(r, "mediaType");
                    if (tmdb <= 0 || kind is not ("movie" or "tv")) continue;
                    var listed = _policy.Listed(viewer, kind == "movie", tmdb);
                    if (listed.LibraryCopy is { } copy)
                    {
                        if (Real(copy, viewer, options) is { } own && !hidden.IsHidden(own, "recommendations")) items.Add(own);
                        continue;
                    }

                    if (!listed.Shown) continue;
                    if (dtos.Card(r) is { } card) items.Add(card);
                }
            }

            return Ok(new QueryResult<BaseItemDto>(0, items.Count, items));
        }

        private async Task<IActionResult> ImageAsync(ActionExecutingContext context, SyntheticId owner, string serverId, CancellationToken ct)
        {
            var tag = Arg<string>(context, "tag");
            if (!_artwork.TryRead(tag, out var grant) || grant == null) return new NotFoundResult();
            var itemId = Arg<Guid?>(context, "itemId");
            var type = context.ActionArguments.TryGetValue("imageType", out var t) && t is ImageType it ? it : (ImageType?)null;
            var index = Arg<int?>(context, "imageIndex") ?? 0;
            if (itemId != grant.Owner || type != grant.Type || index != grant.Index || owner.Kind == 0) return new NotFoundResult();
            User? viewer;
            try
            {
                viewer = _users.GetUserById(grant.Viewer);
            }
            catch (Exception)
            {
                viewer = null;
            }

            if (viewer == null || viewer.HasPermission(PermissionKind.IsDisabled) || _policy.Revision(viewer) != grant.PolicyRevision) return new NotFoundResult();
            // Grants outlive their page: the viewer-level eligibility (Seerr linkage) and, for a title's own
            // artwork, the title-level one (cached rating, request visibility) are checked again.
            if (!await _policy.ViewerMayUseAsync(viewer, ct).ConfigureAwait(false)) return new NotFoundResult();
            // And the page it was minted for: the title (its own artwork and the cast photos shown on it),
            // or a person's own page (an adult performer's photo isn't for a viewer with a parental limit).
            // A rating the cache no longer holds (a restart) is read again rather than refused.
            if (!SyntheticId.TryParse(grant.Context, serverId, out var page)) return new NotFoundResult();
            if (page.IsTitle)
            {
                if (!await _policy.MayListAbsentAsync(viewer, page, ct).ConfigureAwait(false)) return new NotFoundResult();
            }
            else if (page.Kind == SyntheticKind.Person)
            {
                if ((await _source.PersonAsync(page.TmdbId, ct).ConfigureAwait(false)).Data is not { } person || !NativeDetailsPolicy.PersonAllowed(viewer, person)) return new NotFoundResult();
            }
            else
            {
                return new NotFoundResult();
            }
            // An episode still or a later season's poster of a title the viewer guards with Spoiler Guard:
            // never served (a page drawn before they guarded it still holds the URL).
            var spoiler = _presentation?.Load(viewer.Id, context.HttpContext);
            if (HidesArtwork(owner, grant.Type) && Guarded(context.HttpContext, viewer, owner) != null) return new NotFoundResult();
            var pageKey = HiddenContentPolicy.TitleIdentity(page.IsMovie ? "movie" : "tv", page.TmdbId.ToString());
            if (owner.Kind == SyntheticKind.Person && spoiler?.Flags(pageKey ?? "")["cast"]?.GetValue<bool>() == true) return new NotFoundResult();
            var protectedArt = spoiler?.ProtectArtwork(HiddenContentPolicy.TitleIdentity(owner.IsMovie ? "movie" : "tv", owner.TmdbId.ToString()),
                owner.Kind.ToString().ToLowerInvariant(), grant.Type.ToString(), owner.Season) == true;
            var width = Arg<int?>(context, "maxWidth") ?? Arg<int?>(context, "fillWidth") ?? Arg<int?>(context, "width");
            var height = Arg<int?>(context, "fillHeight") ?? Arg<int?>(context, "maxHeight") ?? Arg<int?>(context, "height");
            if (width == null && height is int h) width = grant.Type == ImageType.Backdrop ? h * 16 / 9 : grant.Type == ImageType.Logo ? h * 4 : h * 2 / 3;
            var size = NativeDetailsArtwork.SizeFor(grant.Type, width);
            // One viewer can't make the server fetch without bound: images not cached yet come out of their budget.
            if (!_artwork.IsCached(grant.Path, size) && !_artwork.TakeUpstream(grant.Viewer)) return new StatusCodeResult(StatusCodes.Status429TooManyRequests);
            var image = await _artwork.FetchAsync(grant.Path, size, ct).ConfigureAwait(false);
            if (image is not { } bytes) return new NotFoundResult();
            // The one delivery gate after the fetch (the last await): the artwork is projected under the viewer's policy
            // revisions (an absent title has no watched state or owner of its own) and leaves only when they still hold.
            var headers = context.HttpContext.Response.Headers;
            headers.CacheControl = "private, no-store";
            headers["X-Content-Type-Options"] = "nosniff";
            return PrivacyDelivery.Deliver<IActionResult>(viewer.Id, () =>
            {
                var final = _userConfig == null ? null : TitlePresentationGate.Read(_userConfig, _presentation, viewer.Id, _library);
                return new(ProjectArtwork(final?.Spoilers, owner, grant, size, pageKey, bytes), final?.Revision ?? "-", static _ => false);
            }, () => _userConfig == null ? "-" : TitlePresentationGate.Read(_userConfig, _presentation, viewer.Id, _library).Revision) ?? new StatusCodeResult(StatusCodes.Status503ServiceUnavailable);
        }

        /// <summary>One projection of an absent title's artwork under the viewer's Spoiler Guard presentation.</summary>
        private IActionResult ProjectArtwork(SpoilerPresentationContext? spoiler, SyntheticId owner, ArtworkGrant grant, string size, string? pageKey,
            (byte[] Bytes, string ContentType) bytes)
        {
            if (HidesArtwork(owner, grant.Type) && spoiler?.Guarded(HiddenContentPolicy.TitleIdentity(owner.IsMovie ? "movie" : "tv", owner.TmdbId.ToString())) == true) return new NotFoundResult();
            if (owner.Kind == SyntheticKind.Person && spoiler?.Flags(pageKey ?? "")["cast"]?.GetValue<bool>() == true) return new NotFoundResult();
            var protectedArt = spoiler?.ProtectArtwork(HiddenContentPolicy.TitleIdentity(owner.IsMovie ? "movie" : "tv", owner.TmdbId.ToString()),
                owner.Kind.ToString().ToLowerInvariant(), grant.Type.ToString(), owner.Season) == true;
            if (protectedArt)
            {
                if (_imageBlur == null) return new NotFoundResult();
                var config = JellyfinEnhanced.Instance!.Configuration;
                var cacheKey = grant.Viewer.ToString("N") + "|" + grant.Path + "|" + size + "|" + spoiler!.Revision;
                var projected = config.SpoilerBlurMode == "hide" ? _imageBlur.StockCard(bytes.Bytes, cacheKey)
                    : _imageBlur.Blur(bytes.Bytes, config.SpoilerBlurIntensity, cacheKey);
                return new FileContentResult(projected ?? _imageBlur.HardcodedFallbackJpeg, "image/jpeg");
            }
            return new FileContentResult(bytes.Bytes, bytes.ContentType);
        }

        /// <summary>The viewer's Spoiler Guard state when they guard this title (see <see cref="NativeDetailsSpoilers"/>); else null.</summary>
        private Configuration.UserSpoilerBlur? Guarded(HttpContext http, User viewer, SyntheticId title)
        {
            if (!title.IsTitle) return null;
            if (_presentation != null)
            {
                var context = _presentation.Load(viewer.Id, http);
                var key = HiddenContentPolicy.TitleIdentity(title.IsMovie ? "movie" : "tv", title.TmdbId.ToString());
                if (context.Guarded(key)) return context.State;
                if (context.KnowsTitle(key)) return null;
            }
            return _spoilerStrip == null ? null : NativeDetailsSpoilers.Guarded(_spoilerUsers, _policy, http, viewer, title);
        }

        /// <summary>True for the plot-specific artwork Spoiler Guard hides on a guarded title: an episode's still, a later season's poster.</summary>
        private static bool HidesArtwork(SyntheticId owner, ImageType type)
            => owner.Kind is SyntheticKind.Episode or SyntheticKind.Season
                && HidesArtwork(owner.Kind == SyntheticKind.Episode ? BaseItemKind.Episode : BaseItemKind.Season, owner.Season, type);

        private static bool HidesArtwork(BaseItemKind kind, int season, ImageType type)
            => (kind == BaseItemKind.Episode && type is ImageType.Primary or ImageType.Thumb or ImageType.Screenshot)
                || (kind == BaseItemKind.Season && season > 1 && type == ImageType.Primary);

        /// <summary>
        /// Spoiler Guard's treatment of a guarded title's answer, as its library copy would get it with
        /// nothing watched (the absent parts never are): the admin's and viewer's strip, and no
        /// plot-specific artwork (no grant, so no image; the page falls back to the series' own art).
        /// </summary>
        /// <summary>
        /// Spoiler Guard's own strip over the library items a list holds (parts the viewer can open in the
        /// library are listed as themselves): JE's strip filter never sees these answers otherwise.
        /// </summary>
        private IActionResult Library(IActionResult result, ActionExecutingContext context, User viewer, string surface = "library")
        {
            if (_userConfig != null && result is OkObjectResult ok && ok.Value is QueryResult<BaseItemDto> query)
            {
                var hidden = HiddenContentPolicy.Load(_userConfig, viewer.Id, context.HttpContext, _library);
                hidden.BindLibraryIds(_library, query.Items.Select(i => i.Id));
                var kept = query.Items.Where(dto => {
                    var key = SyntheticId.TryParse(dto.Id, _host.SystemId, out var synthetic) && synthetic.IsTitle
                        ? HiddenContentPolicy.TitleIdentity(synthetic.IsMovie ? "movie" : "tv", synthetic.TmdbId.ToString()) : null;
                    return !hidden.IsHidden(key, dto.Id.ToString(), dto.SeriesId?.ToString(), surface)
                        && !hidden.IsHidden(dto, surface);
                }).ToArray();
                ok.Value = new QueryResult<BaseItemDto>(query.StartIndex, Math.Max(0, query.TotalRecordCount - query.Items.Count + kept.Length), kept);
            }
            if (result is OkObjectResult cards && cards.Value is QueryResult<BaseItemDto> page && page.Items != null)
                // Each absent title is judged by its own guard and replaced by what the strip delivers in its place.
                page.Items = page.Items.Select(dto => dto != null && SyntheticId.TryParse(dto.Id, _host.SystemId, out var title) && title.IsTitle
                    ? (BaseItemDto)((OkObjectResult)Guard(new OkObjectResult(dto), Guarded(context.HttpContext, viewer, title), viewer)).Value! : dto!).ToArray();
            _spoilerStrip?.StripLibraryItems(result, context, viewer.Id);
            return result;
        }

        private IActionResult Guard(IActionResult result, Configuration.UserSpoilerBlur? state, User viewer)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || result is not OkObjectResult ok) return result;
            // Library items in the list are stripped by Spoiler Guard's own rules (Library), by watched state; each absent
            // title is replaced by what the strip delivers in its place.
            BaseItemDto Absent(BaseItemDto dto)
            {
                if (!SyntheticId.HasNamespace(dto.Id)) return dto;
                dto.ProviderIds ??= new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                dto.ProviderIds["JeSpoilerGuarded"] = state != null ? "true" : "false";
                if (state == null || _spoilerStrip == null) return dto;
                dto = _spoilerStrip.StripAbsent(dto, state, config, viewer.Id);
                if (!HidesArtwork(dto.Type, dto.IndexNumber ?? 0, ImageType.Primary)) return dto;
                dto.ImageTags?.Remove(ImageType.Primary);
                dto.ImageTags?.Remove(ImageType.Thumb);
                dto.ImageBlurHashes = null;
                dto.PrimaryImageAspectRatio = null;
                return dto;
            }
            NativeResponseValue.Replace(ok, Absent);

            return result;
        }

        /// <summary>Item batches leave synthetic ids out: never answered, never passed to the native query.</summary>
        private static IActionResult? Batch(ActionExecutingContext context, List<(string Argument, SyntheticId Id)> hits, string serverId)
        {
            var empty = new OkObjectResult(new QueryResult<BaseItemDto>(0, 0, Array.Empty<BaseItemDto>()));
            // A synthetic parent, genre, person, studio ... can only match nothing.
            if (hits.Any(h => h.Argument is not ("ids" or "excludeItemIds"))) return empty;
            foreach (var name in new[] { "ids", "excludeItemIds" })
            {
                if (!context.ActionArguments.TryGetValue(name, out var raw) || raw is not Guid[] ids) continue;
                var kept = ids.Where(g => !SyntheticId.TryParse(g, serverId, out _)).ToArray();
                // Only synthetic ids asked for: an empty id list would mean "everything".
                if (name == "ids" && kept.Length == 0) return empty;
                context.ActionArguments[name] = kept;
            }

            return null;
        }

        private static ThemeMediaResult Theme(Guid owner) => new() { OwnerId = owner, Items = Array.Empty<BaseItemDto>(), StartIndex = 0, TotalRecordCount = 0 };

        private static T? Arg<T>(ActionExecutingContext context, string name)
            => context.ActionArguments.TryGetValue(name, out var value) && value is T typed ? typed : default;

        private static OkObjectResult Ok(object value) => new(value);

        private static IActionResult Unavailable() => new StatusCodeResult(StatusCodes.Status503ServiceUnavailable);

        /// <summary>No data: 404 when the source says the title doesn't exist, 503 when it can't answer now.</summary>
        /// <remarks>A read the viewer's feed budget can't start now (<see cref="SourceAnswer.Busy"/>): 429, try again shortly.</remarks>
        private static IActionResult Failed(SourceAnswer answer)
            => answer.Busy ? new StatusCodeResult(StatusCodes.Status429TooManyRequests) : answer.NotFound ? new NotFoundResult() : Unavailable();

        private static IActionResult Refuse(string method)
            => HttpMethods.IsGet(method) || HttpMethods.IsHead(method) ? new NotFoundResult() : new StatusCodeResult(StatusCodes.Status403Forbidden);
    }
}
#endif
