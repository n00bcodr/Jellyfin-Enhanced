#if JF12
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Providers;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>
    /// Builds the viewer-projected DTOs of a synthetic page from public Seerr/TMDB data. Every DTO
    /// is <c>LocationType=Virtual</c> with neutral user data, no media sources, zero
    /// special-feature/trailer/part/source counts and no delete/download; artwork tags are grants
    /// for the viewer (see <see cref="NativeDetailsArtwork"/>).
    /// </summary>
    public sealed class NativeDetailsDtos
    {
        private const int MaxCast = 40;
        private const int MaxStudios = 6;
        private readonly string _serverId;
        private readonly Guid _viewer;
        private readonly string _revision;
        private readonly NativeDetailsArtwork _artwork;
        private readonly string _region;
        private readonly ITitleLinks _links;

        /// <summary>Creates a builder for one viewer.</summary>
        /// <param name="serverId">This server's id.</param>
        /// <param name="viewer">The effective viewer (artwork grants are theirs).</param>
        /// <param name="revision">The viewer's policy revision.</param>
        /// <param name="artwork">Artwork grants.</param>
        /// <param name="region">Certification region.</param>
        /// <param name="links">Where the page's people, genres, studios and tags lead for the viewer.</param>
        public NativeDetailsDtos(string serverId, Guid viewer, string revision, NativeDetailsArtwork artwork, string region, ITitleLinks links)
        {
            _serverId = serverId;
            _viewer = viewer;
            _revision = revision;
            _artwork = artwork;
            _region = region;
            _links = links;
        }

        /// <summary>The GUID of a synthetic id on this server.</summary>
        public Guid Id(SyntheticId id) => id.ToGuid(_serverId);

        /// <summary>A movie page DTO.</summary>
        public BaseItemDto Movie(SyntheticId id, JsonElement m, string? logo)
        {
            var guid = Id(id);
            var dto = Base(guid, BaseItemKind.Movie, Str(m, "title") ?? Str(m, "originalTitle") ?? string.Empty, folder: false);
            dto.OriginalTitle = Str(m, "originalTitle");
            dto.Overview = Str(m, "overview");
            dto.Taglines = Str(m, "tagline") is { Length: > 0 } t ? new[] { t } : Array.Empty<string>();
            var release = Date(m, "releaseDate");
            dto.PremiereDate = release;
            dto.ProductionYear = release?.Year;
            dto.RunTimeTicks = Int(m, "runtime") is int minutes and > 0 ? minutes * TimeSpan.TicksPerMinute : null;
            dto.OfficialRating = SeerrCertificationExtractor.Extract(m, "movie", _region).Certification;
            dto.CommunityRating = Rating(m);
            Genres(dto, m);
            dto.Studios = Studios(m, "productionCompanies", network: false);
            dto.Tags = Tags(m);
            dto.ProductionLocations = Names(m, "productionCountries");
            dto.People = People(m, movie: true);
            dto.RemoteTrailers = Trailers(m);
            var imdb = Str(m, "imdbId") ?? Str(Obj(m, "externalIds"), "imdbId");
            dto.ProviderIds = Providers(id.TmdbId, imdb, null);
            dto.ExternalUrls = Links(true, id.TmdbId, imdb, null);
            OwnArt(dto, guid, Str(m, "posterPath"), Str(m, "backdropPath"), logo);
            dto.PrimaryImageAspectRatio = 2.0 / 3.0;
            return dto;
        }

        /// <summary>A series page DTO.</summary>
        public BaseItemDto Series(SyntheticId id, JsonElement s, string? logo)
        {
            var guid = Id(id);
            var dto = Base(guid, BaseItemKind.Series, Str(s, "name") ?? Str(s, "originalName") ?? string.Empty, folder: true);
            dto.OriginalTitle = Str(s, "originalName");
            dto.Overview = Str(s, "overview");
            dto.Taglines = Str(s, "tagline") is { Length: > 0 } t ? new[] { t } : Array.Empty<string>();
            var first = Date(s, "firstAirDate");
            dto.PremiereDate = first;
            dto.ProductionYear = first?.Year;
            var status = Str(s, "status");
            var ended = status is "Ended" or "Canceled";
            dto.Status = ended ? "Ended" : "Continuing";
            dto.EndDate = ended ? Date(s, "lastAirDate") : null;
            var runtime = Obj(s, "episodeRunTime") is { ValueKind: JsonValueKind.Array } rt && rt.GetArrayLength() > 0 && rt[0].TryGetInt32(out var r) ? r : 0;
            dto.RunTimeTicks = runtime > 0 ? runtime * TimeSpan.TicksPerMinute : null;
            dto.OfficialRating = SeerrCertificationExtractor.Extract(s, "tv", _region).Certification;
            dto.CommunityRating = Rating(s);
            Genres(dto, s);
            dto.Studios = Studios(s, "networks", network: true);
            dto.Tags = Tags(s);
            dto.ProductionLocations = Names(s, "productionCountries");
            dto.People = People(s, movie: false);
            dto.RemoteTrailers = Trailers(s);
            var external = Obj(s, "externalIds");
            var tvdb = Int(external, "tvdbId");
            var imdb = Str(external, "imdbId");
            dto.ProviderIds = Providers(id.TmdbId, imdb, tvdb);
            dto.ExternalUrls = Links(false, id.TmdbId, imdb, tvdb);
            dto.ChildCount = Seasons(s).Count();
            OwnArt(dto, guid, Str(s, "posterPath"), Str(s, "backdropPath"), logo);
            dto.PrimaryImageAspectRatio = 2.0 / 3.0;
            return dto;
        }

        /// <summary>A season page or season card DTO (from the series' season summary).</summary>
        public BaseItemDto Season(SyntheticId id, JsonElement series, JsonElement summary, string? logo)
        {
            var guid = Id(id);
            var seriesGuid = Id(id.SeriesId);
            var number = Int(summary, "seasonNumber") ?? id.Season;
            var dto = Base(guid, BaseItemKind.Season, Str(summary, "name") ?? ("Season " + number.ToString(CultureInfo.InvariantCulture)), folder: true);
            dto.Overview = Str(summary, "overview");
            dto.IndexNumber = number;
            dto.SeriesId = seriesGuid;
            dto.SeriesName = Str(series, "name");
            dto.ParentId = seriesGuid;
            var air = Date(summary, "airDate");
            dto.PremiereDate = air;
            dto.ProductionYear = air?.Year;
            dto.ChildCount = Int(summary, "episodeCount") ?? 0;
            dto.RecursiveItemCount = dto.ChildCount;
            var poster = Str(summary, "posterPath");
            if (Grant(guid, ImageType.Primary, 0, poster) is { } p) dto.ImageTags[ImageType.Primary] = p;
            ParentArt(dto, seriesGuid, series, logo);
            dto.PrimaryImageAspectRatio = 2.0 / 3.0;
            return dto;
        }

        /// <summary>An episode page, missing row or sibling card DTO.</summary>
        public BaseItemDto Episode(SyntheticId id, JsonElement series, JsonElement season, JsonElement episode, string? logo)
        {
            var guid = Id(id);
            var seriesGuid = Id(id.SeriesId);
            var seasonGuid = Id(id.SeasonId);
            var dto = Base(guid, BaseItemKind.Episode, Str(episode, "name") ?? string.Empty, folder: false);
            dto.Overview = Str(episode, "overview");
            dto.IndexNumber = Int(episode, "episodeNumber") ?? id.Episode;
            dto.ParentIndexNumber = Int(episode, "seasonNumber") ?? id.Season;
            dto.SeriesId = seriesGuid;
            dto.SeriesName = Str(series, "name");
            dto.SeasonId = seasonGuid;
            dto.SeasonName = Str(season, "name");
            dto.ParentId = seasonGuid;
            var air = Date(episode, "airDate");
            dto.PremiereDate = air;
            dto.ProductionYear = air?.Year;
            dto.RunTimeTicks = Int(episode, "runtime") is int minutes and > 0 ? minutes * TimeSpan.TicksPerMinute : null;
            dto.CommunityRating = Rating(episode);
            var stillPath = Str(episode, "stillPath");
            if (Grant(guid, ImageType.Primary, 0, stillPath) is { } still)
            {
                dto.ImageTags[ImageType.Primary] = still;
                dto.PrimaryImageAspectRatio = 16.0 / 9.0;
                // Thumb-preferring cards (More from season) show the still, not the series backdrop.
                if (Grant(guid, ImageType.Thumb, 0, stillPath) is { } thumb) dto.ImageTags[ImageType.Thumb] = thumb;
            }

            ParentArt(dto, seriesGuid, series, logo);
            return dto;
        }

        /// <summary>
        /// A person page DTO (a cast or crew member Jellyfin has no page for): photo, name, biography,
        /// birth and death dates, birthplace and, as the tagline, the department TMDB knows them for.
        /// No library filmography: the page's titles come from Jellyfin Enhanced's person discovery row.
        /// </summary>
        public BaseItemDto Person(SyntheticId id, JsonElement p)
        {
            var guid = Id(id);
            var dto = Base(guid, BaseItemKind.Person, Str(p, "name") ?? string.Empty, folder: false);
            dto.MediaType = MediaType.Unknown;
            dto.Overview = Str(p, "biography");
            dto.PremiereDate = Date(p, "birthday");
            dto.EndDate = Date(p, "deathday");
            dto.ProductionLocations = Str(p, "placeOfBirth") is { Length: > 0 } place ? new[] { place } : Array.Empty<string>();
            dto.Taglines = Str(p, "knownForDepartment") is { Length: > 0 } department ? new[] { department } : Array.Empty<string>();
            var imdb = Str(p, "imdbId");
            dto.ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = id.TmdbId.ToString(CultureInfo.InvariantCulture) };
            var links = new List<ExternalUrl>();
            if (!string.IsNullOrEmpty(imdb) && imdb.StartsWith("nm", StringComparison.Ordinal) && imdb.Length > 2 && imdb.Skip(2).All(char.IsAsciiDigit))
            {
                dto.ProviderIds["Imdb"] = imdb;
                links.Add(new ExternalUrl { Name = "IMDb", Url = "https://www.imdb.com/name/" + imdb });
            }

            links.Add(new ExternalUrl { Name = "TheMovieDb", Url = "https://www.themoviedb.org/person/" + id.TmdbId.ToString(CultureInfo.InvariantCulture) });
            dto.ExternalUrls = links.ToArray();
            if (Grant(guid, ImageType.Primary, 0, Str(p, "profilePath")) is { } photo)
            {
                dto.ImageTags[ImageType.Primary] = photo;
                dto.PrimaryImageAspectRatio = 2.0 / 3.0;
            }

            return dto;
        }

        /// <summary>The DTO of a genre, studio or network discovery page (a name; its titles come from Jellyfin Enhanced's discovery row).</summary>
        public BaseItemDto NamePage(SyntheticId id, string name)
        {
            var dto = Base(Id(id), id.Kind == SyntheticKind.Genre ? BaseItemKind.Genre : BaseItemKind.Studio, name, folder: false);
            dto.MediaType = MediaType.Unknown;
            dto.ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = id.TmdbId.ToString(CultureInfo.InvariantCulture) };
            return dto;
        }

        /// <summary>A similar-rail card for a recommended title that is not in the library.</summary>
        public BaseItemDto? Card(JsonElement result)
        {
            var mediaType = Str(result, "mediaType");
            var tmdb = Int(result, "id") ?? 0;
            if (tmdb <= 0 || mediaType is not ("movie" or "tv")) return null;
            var movie = mediaType == "movie";
            var id = movie ? SyntheticId.Movie(tmdb) : SyntheticId.Series(tmdb);
            var guid = Id(id);
            var dto = Base(guid, movie ? BaseItemKind.Movie : BaseItemKind.Series, Str(result, movie ? "title" : "name") ?? string.Empty, folder: !movie);
            var date = Date(result, movie ? "releaseDate" : "firstAirDate");
            dto.PremiereDate = date;
            dto.ProductionYear = date?.Year;
            dto.CommunityRating = Rating(result);
            dto.ProviderIds = Providers(tmdb, null, null);
            OwnArt(dto, guid, Str(result, "posterPath"), Str(result, "backdropPath"), null);
            dto.PrimaryImageAspectRatio = 2.0 / 3.0;
            return dto;
        }

        /// <summary>The season summaries of a series, in season order.</summary>
        public static IEnumerable<JsonElement> Seasons(JsonElement series)
            => Obj(series, "seasons") is { ValueKind: JsonValueKind.Array } seasons
                ? seasons.EnumerateArray().Where(e => Int(e, "seasonNumber") is int n && n >= 0).OrderBy(e => Int(e, "seasonNumber"))
                : Enumerable.Empty<JsonElement>();

        /// <summary>The episodes of a season detail, in episode order.</summary>
        public static IEnumerable<JsonElement> Episodes(JsonElement season)
            => Obj(season, "episodes") is { ValueKind: JsonValueKind.Array } episodes
                ? episodes.EnumerateArray().Where(e => Int(e, "episodeNumber") is int n && n >= 0).OrderBy(e => Int(e, "episodeNumber"))
                : Enumerable.Empty<JsonElement>();

        private BaseItemDto Base(Guid id, BaseItemKind kind, string name, bool folder)
            => new()
            {
                Id = id,
                ServerId = _serverId,
                Name = name,
                SortName = name,
                Type = kind,
                IsFolder = folder,
                MediaType = folder ? MediaType.Unknown : MediaType.Video,
                LocationType = LocationType.Virtual,
                UserData = new UserItemDataDto { Key = id.ToString("N"), ItemId = id, IsFavorite = false, Played = false, PlayCount = 0, PlaybackPositionTicks = 0 },
                CanDelete = false,
                CanDownload = false,
                SpecialFeatureCount = 0,
                LocalTrailerCount = 0,
                PartCount = 0,
                MediaSourceCount = 0,
                MediaSources = Array.Empty<MediaBrowser.Model.Dto.MediaSourceInfo>(),
                ImageTags = new Dictionary<ImageType, string>(),
                BackdropImageTags = Array.Empty<string>(),
                ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase),
                ExternalUrls = Array.Empty<ExternalUrl>(),
                People = Array.Empty<BaseItemPerson>(),
                Genres = Array.Empty<string>(),
                GenreItems = Array.Empty<NameGuidPair>(),
                Studios = Array.Empty<NameGuidPair>(),
                Tags = Array.Empty<string>(),
                Taglines = Array.Empty<string>(),
                RemoteTrailers = Array.Empty<MediaUrl>(),
            };

        private string? Grant(Guid owner, ImageType type, int index, string? path)
            => _artwork.Mint(owner, type, index, TmdbPath(path), _viewer, _revision);

        /// <summary>
        /// A TMDB file path ("/abc.jpg"). Seerr gives some images as full TMDB URLs
        /// ("https://image.tmdb.org/t/p/original//abc.jpg", e.g. episode stills); only the file name is kept.
        /// </summary>
        internal static string? TmdbPath(string? path)
        {
            if (string.IsNullOrEmpty(path)) return null;
            if (path.StartsWith("https://image.tmdb.org/t/p/", StringComparison.Ordinal))
            {
                var slash = path.LastIndexOf('/');
                return slash >= 0 ? path.Substring(slash) : null;
            }

            return path;
        }

        private void OwnArt(BaseItemDto dto, Guid owner, string? poster, string? backdrop, string? logo)
        {
            if (Grant(owner, ImageType.Primary, 0, poster) is { } p) dto.ImageTags[ImageType.Primary] = p;
            if (Grant(owner, ImageType.Logo, 0, logo) is { } l) dto.ImageTags[ImageType.Logo] = l;
            if (Grant(owner, ImageType.Backdrop, 0, backdrop) is { } b) dto.BackdropImageTags = new[] { b };
        }

        private void ParentArt(BaseItemDto dto, Guid seriesGuid, JsonElement series, string? logo)
        {
            if (Grant(seriesGuid, ImageType.Backdrop, 0, Str(series, "backdropPath")) is { } b)
            {
                dto.ParentBackdropItemId = seriesGuid;
                dto.ParentBackdropImageTags = new[] { b };
            }

            if (Grant(seriesGuid, ImageType.Logo, 0, logo) is { } l)
            {
                dto.ParentLogoItemId = seriesGuid;
                dto.ParentLogoImageTag = l;
            }

            if (Grant(seriesGuid, ImageType.Primary, 0, Str(series, "posterPath")) is { } p) dto.SeriesPrimaryImageTag = p;
        }

        private BaseItemPerson[] People(JsonElement title, bool movie)
        {
            var people = new List<BaseItemPerson>();
            var credits = Obj(title, "credits");
            if (Obj(credits, "cast") is { ValueKind: JsonValueKind.Array } cast)
            {
                foreach (var c in cast.EnumerateArray().OrderBy(c => Int(c, "order") ?? int.MaxValue).Take(MaxCast))
                {
                    if (CastMember(c, PersonKind.Actor, Str(c, "character")) is { } p) people.Add(p);
                }
            }

            if (Obj(credits, "crew") is { ValueKind: JsonValueKind.Array } crew)
            {
                foreach (var c in crew.EnumerateArray())
                {
                    var job = Str(c, "job");
                    var kind = job switch
                    {
                        "Director" when movie => PersonKind.Director,
                        "Screenplay" or "Writer" when movie => PersonKind.Writer,
                        _ => (PersonKind?)null,
                    };
                    if (kind is { } k && people.Count(x => x.Type == k) < 6 && CastMember(c, k, job) is { } p) people.Add(p);
                }
            }

            if (!movie && Obj(title, "createdBy") is { ValueKind: JsonValueKind.Array } creators)
            {
                foreach (var c in creators.EnumerateArray().Take(6))
                {
                    if (CastMember(c, PersonKind.Creator, null) is { } p) people.Add(p);
                }
            }

            return people.ToArray();
        }

        /// <summary>
        /// A cast or crew entry: the library's person when Jellyfin has them and the viewer can open their
        /// page (with its own photo), else the person's own page made from public data (photo by grant).
        /// </summary>
        private BaseItemPerson? CastMember(JsonElement p, PersonKind kind, string? role)
        {
            var tmdb = Int(p, "id") ?? 0;
            var name = Str(p, "name");
            if (tmdb <= 0 || string.IsNullOrEmpty(name)) return null;
            if (_links.Person(name, tmdb) is { } library)
            {
                return new BaseItemPerson { Id = library.Id, Name = name, Role = role, Type = kind, PrimaryImageTag = library.ImageTag };
            }

            var guid = Id(SyntheticId.Person(tmdb));
            return new BaseItemPerson
            {
                Id = guid,
                Name = name,
                Role = role,
                Type = kind,
                PrimaryImageTag = Grant(guid, ImageType.Primary, 0, Str(p, "profilePath")),
            };
        }

        /// <summary>The title's genres; each links to the library genre or the genre's discovery page (none: text only, left out of the links).</summary>
        private void Genres(BaseItemDto dto, JsonElement title)
        {
            dto.Genres = Names(title, "genres");
            var items = new List<NameGuidPair>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var (name, tmdb) in Named(title, "genres"))
            {
                if (seen.Add(name) && _links.Genre(name, tmdb) is { } id) items.Add(new NameGuidPair { Name = name, Id = id });
            }

            dto.GenreItems = items.ToArray();
        }

        /// <summary>A movie's production companies or a series' networks, each linked to the library studio or its discovery page.</summary>
        private NameGuidPair[] Studios(JsonElement title, string property, bool network)
        {
            var items = new List<NameGuidPair>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var (name, tmdb) in Named(title, property))
            {
                if (items.Count >= MaxStudios) break;
                if (seen.Add(name) && _links.Studio(name, tmdb, network) is { } id) items.Add(new NameGuidPair { Name = name, Id = id });
            }

            return items.ToArray();
        }

        /// <summary>The title's keywords as tags, only those that lead somewhere for the viewer.</summary>
        private string[] Tags(JsonElement title) => Names(title, "keywords").Where(_links.Tag).ToArray();

        /// <summary>The (name, TMDB id) pairs of a named-object array (genres, companies, networks).</summary>
        private static IEnumerable<(string Name, int Tmdb)> Named(JsonElement e, string name)
            => Obj(e, name) is { ValueKind: JsonValueKind.Array } a
                ? a.EnumerateArray().Select(x => (Name: Str(x, "name")?.Trim() ?? string.Empty, Tmdb: Int(x, "id") ?? 0)).Where(x => x.Name.Length > 0).Take(30)
                : Enumerable.Empty<(string, int)>();

        private static MediaUrl[] Trailers(JsonElement title)
        {
            if (Obj(title, "relatedVideos") is not { ValueKind: JsonValueKind.Array } videos) return Array.Empty<MediaUrl>();
            return videos.EnumerateArray()
                .Where(v => Str(v, "site") == "YouTube" && Str(v, "type") == "Trailer" && Str(v, "key") is { Length: > 0 and < 32 } key && key.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_'))
                .Take(3)
                .Select(v => new MediaUrl { Url = "https://www.youtube.com/watch?v=" + Str(v, "key"), Name = Str(v, "name") })
                .ToArray();
        }

        private static Dictionary<string, string> Providers(int tmdb, string? imdb, int? tvdb)
        {
            var ids = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = tmdb.ToString(CultureInfo.InvariantCulture) };
            if (!string.IsNullOrEmpty(imdb)) ids["Imdb"] = imdb;
            if (tvdb is > 0) ids["Tvdb"] = tvdb.Value.ToString(CultureInfo.InvariantCulture);
            return ids;
        }

        private static ExternalUrl[] Links(bool movie, int tmdb, string? imdb, int? tvdb)
        {
            var links = new List<ExternalUrl>();
            if (!string.IsNullOrEmpty(imdb) && imdb.StartsWith("tt", StringComparison.Ordinal) && imdb.Skip(2).All(char.IsAsciiDigit))
                links.Add(new ExternalUrl { Name = "IMDb", Url = "https://www.imdb.com/title/" + imdb });
            links.Add(new ExternalUrl { Name = "TheMovieDb", Url = "https://www.themoviedb.org/" + (movie ? "movie/" : "tv/") + tmdb.ToString(CultureInfo.InvariantCulture) });
            if (tvdb is > 0) links.Add(new ExternalUrl { Name = "TheTVDB", Url = "https://www.thetvdb.com/?tab=series&id=" + tvdb.Value.ToString(CultureInfo.InvariantCulture) });
            return links.ToArray();
        }

        private static float? Rating(JsonElement e)
            => Obj(e, "voteAverage") is { ValueKind: JsonValueKind.Number } v && v.TryGetDouble(out var d) && d > 0 ? (float)Math.Round(d, 1) : null;

        private static string[] Names(JsonElement e, string name)
            => Obj(e, name) is { ValueKind: JsonValueKind.Array } a
                ? a.EnumerateArray().Select(x => Str(x, "name")).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!).Distinct().Take(30).ToArray()
                : Array.Empty<string>();

        private static DateTime? Date(JsonElement e, string name)
            => Str(e, name) is { } s && DateTime.TryParseExact(s, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var d) ? d : null;

        /// <summary>A property of an object, or an undefined element.</summary>
        internal static JsonElement Obj(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) ? v : default;

        /// <summary>A string property, or null.</summary>
        internal static string? Str(JsonElement e, string name)
            => Obj(e, name) is { ValueKind: JsonValueKind.String } v ? v.GetString() : null;

        /// <summary>An integer property, or null.</summary>
        internal static int? Int(JsonElement e, string name)
            => Obj(e, name) is { ValueKind: JsonValueKind.Number } v && v.TryGetInt32(out var i) ? i : null;
    }
}
#endif
