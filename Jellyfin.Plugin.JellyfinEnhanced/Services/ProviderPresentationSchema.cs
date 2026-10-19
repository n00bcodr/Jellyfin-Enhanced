using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json.Nodes;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>Declared provider/JE node roles and field dispositions used by both presentation policies at runtime.</summary>
public static class ProviderPresentationSchema
{
    private enum Role { Envelope, Title, Person, Episode, Season, Notification, Text, Ratings, Artwork, Metadata }
    private enum Disposition { Allow, Project, Remove }
    private sealed record Field(Disposition Disposition, string? Child = null, string? Policy = null, string? Kind = null, string? Surface = null);
    private sealed record Schema(Role Role, Dictionary<string, Field> Fields, bool Countries = false);
    private static string Key(string key) => key.Replace("_", "", StringComparison.Ordinal).ToLowerInvariant();
    private static readonly Dictionary<string, Schema> Schemas = Declare();

    private static Dictionary<string, Schema> Declare()
    {
        var schemas = new Dictionary<string, Schema>(StringComparer.Ordinal);
        void Add(string name, Role role, string allowed, string projected = "")
        {
            var fields = new Dictionary<string, Field>(StringComparer.Ordinal);
            foreach (var field in allowed.Split(' ', StringSplitOptions.RemoveEmptyEntries)) fields[Key(field)] = new(Disposition.Allow);
            foreach (var field in projected.Split(' ', StringSplitOptions.RemoveEmptyEntries)) fields[Key(field)] = new(Disposition.Project);
            schemas[name] = new(role, fields);
        }
        void Children(string schema, string fields, string child, string? policy = null, string? kind = null, string? surface = null)
        {
            foreach (var field in fields.Split(' ', StringSplitOptions.RemoveEmptyEntries))
                schemas[schema].Fields[Key(field)] = new(Disposition.Project, child, policy, kind, surface);
        }
        Add("title", Role.Title,
            "id mediaType type kind key tmdbId adult name title originalName originalTitle originalLanguage language popularity genreIds originCountry homepage status runtime episodeRunTime numberOfEpisodes numberOfSeasons inProduction budget revenue imdbId year video softcore languages onUserWatchlist creditId episodeCount firstCreditAirDate order itemId inLibrary requested mine liveKey request is4k askedAt readyAt group series seriesId season displayMissing canRequest seasonRequest",
            "overview description summary plot tagline taglines voteAverage voteCount rating ratings communityRating criticRating awards posterPath posterUrl poster backdropPath backdropUrl backdrop logoPath logoUrl logo stillPath still releaseDate releaseDateLocal firstAirDate lastAirDate airDate airDateUtc nextAirDate nextDate nextDay digitalReleaseDate theatricalReleaseDate initialAirDate digitalRelease physicalRelease inCinemas physicalReleaseNote date episodeTitle episodeName subtitle character job department content");
        Add("episode", Role.Episode,
            "id tmdbId seasonNumber episodeNumber episode season productionCode runtime showId episodeType request",
            "name title originalName originalTitle overview description voteAverage voteCount airDate stillPath still posterPath");
        Add("season", Role.Season, "id seasonNumber episodeCount", "name overview airDate posterPath voteAverage");
        Add("person", Role.Person,
            "alsoKnownAs homepage biography birthday deathday placeOfBirth imdbId id name originalName gender knownForDepartment popularity profilePath adult castId creditId order totalEpisodeCount",
            "character job department");
        Add("role", Role.Metadata, "creditId episodeCount", "character job");
        Add("named", Role.Metadata, "id name iso6391 englishName iso31661 originCountry logoPath");
        Add("media", Role.Title,
            "id tmdbId tvdbId mediaType status status4k jellyfinMediaId jellyfinMediaId4k jellyfinMediaUrl jellyfinMediaUrl4k createdAt updatedAt lastSeasonChange serviceId serviceId4k externalServiceId externalServiceId4k mediaAddedAt seasonNumber");
        Add("request", Role.Title, "id status type is4k createdAt updatedAt");
        Add("user", Role.Person, "id displayName username email avatar jellyfinUsername jellyfinUserId userType");
        Add("calendar", Role.Title,
            "id source type title dateOnly releaseType hasFile monitored imdbId itemId itemEpisodeId tvdbId seasonNumber episodeNumber episodeTvdbId episodeImdbId seriesId tmdbId shokoSeriesId shokoEpisodeId instanceName alsoInInstances year",
            "subtitle episodeTitle episodeName overview posterUrl backdropUrl releaseDate releaseDateLocal airDateUtc airDate digitalRelease physicalRelease inCinemas");
        schemas["calendar"].Fields["arrpath"] = new(Disposition.Remove);
        schemas["calendar"].Fields["instanceid"] = new(Disposition.Remove);
        Add("person-search", Role.Envelope, "page totalPages totalResults");
        Add("named-search", Role.Envelope, "page totalPages totalResults");
        Add("named-lookup", Role.Envelope, "");
        Add("page", Role.Envelope, "id page totalPages totalResults totalRecordCount startIndex list type more contact lookingHours canApproveRequests outcome reason certainty message");
        Add("hub-seerr", Role.Metadata, "configured loaded unavailable ledger");
        Add("hub-arr", Role.Metadata, "unavailable");
        Add("hub-admin", Role.Metadata, "downloads calendar hub");
        Add("seerr-state", Role.Metadata, "active lastReadAt lastError requests calls truncated reportedTotal readLimit incompleteReason");
        Add("provider-error", Role.Metadata, "instanceName source reason detail");
        Add("group", Role.Title, "key basedOn");
        Add("image", Role.Artwork, "iso31661 aspectRatio height width iso6391 filePath", "voteAverage voteCount");
        Add("images", Role.Artwork, "id");
        Add("credits", Role.Envelope, "id");
        Add("videos", Role.Text, "id");
        Add("keywords", Role.Text, "id");
        Add("reviews", Role.Text, "id page totalPages totalResults");
        Add("release_dates", Role.Metadata, "id");
        Add("content_ratings", Role.Metadata, "id iso31661 rating descriptors");
        Add("external_ids", Role.Metadata, "id imdbId tvdbId tvrageId wikidataId facebookId instagramId twitterId freebaseMid freebaseId");
        Add("watch/providers", Role.Metadata, "id");
        Add("countries", Role.Metadata, ""); schemas["countries"] = schemas["countries"] with { Countries = true };
        Add("providers", Role.Metadata, "link");
        Add("provider", Role.Metadata, "displayPriority logoPath providerId providerName");
        Add("seerr-provider-country", Role.Metadata, "iso31661 link");
        Add("seerr-provider", Role.Metadata, "displayPriority logoPath id name");
        Children("seerr-provider-country", "flatrate rent buy ads free", "seerr-provider");
        Add("video", Role.Text, "url id iso6391 iso31661 name key site size type official publishedAt");
        Add("review", Role.Text, "id author username name avatarPath createdAt updatedAt url", "rating content");
        Add("release", Role.Metadata, "iso31661 certification descriptors iso6391 note type", "releaseDate");
        Add("translations", Role.Envelope, "id");
        Add("translation", Role.Metadata, "iso6391 iso31661 name englishName");
        Add("translation-data", Role.Text, "title name homepage runtime", "overview tagline");
        Add("ratings", Role.Ratings, "id found wins nominations confirmed fetchedAtUnixMs", "rt imdb tmdb metacritic rottenTomatoes ratings awards");
        Add("score", Role.Ratings, "url title source fresh year", "criticsScore criticsScoreCount criticsRating audienceScore audienceRating score rating voteCount votes value");
        Add("award", Role.Ratings, "name result year recipients works");
        Add("rating-ids", Role.Metadata, "imdb tmdb trakt mal anilist tvdb letterboxd");
        Add("inbox", Role.Envelope, "unread more");
        Add("notification", Role.Notification, "id kind key itemId createdAt read link");
        Add("notification-params", Role.Metadata, "title year poster image count season episode episodes reason contact name library instance free total code");
        Add("activity", Role.Envelope, "more");
        Add("activity-row", Role.Text, "activityType userId userName userHasPrimaryImage timestamp completed progress", "rating content");
        Add("activity-item", Role.Metadata, "id name type productionYear seriesName seriesId seasonNumber episodeNumber hasPrimaryImage hasThumbImage seriesHasPrimaryImage seriesHasThumbImage");
        Add("user-reviews", Role.Envelope, "totalReviews", "averageRating");
        Add("user-review", Role.Text, "userId userName tmdbId mediaType createdAt updatedAt", "content rating");
        Add("review-ratings", Role.Envelope, ""); Add("review-rating-map", Role.Envelope, "");
        Add("review-rating", Role.Ratings, "average count");
        Add("flags", Role.Metadata, "guarded overview ratings dates cast tags reviews revision");
        Add("block", Role.Metadata, "code reason message until");
        // Response wrappers are explicit adapters, never an unrestricted recursive traversal.
        foreach (var field in new[] { "answer", "data", "body", "rows" }) Children("page", field, "page");
        Children("person-search", "results", "person");
        Children("named-search", "results", "named"); Children("named-lookup", "genres keywords", "named");
        Children("page", "results cast crew parts items events requests mine soon ready", "title");
        Children("page", "seerr", "hub-seerr"); Children("page", "arr", "hub-arr"); Children("page", "admin", "hub-admin");
        Children("hub-admin", "seerr", "seerr-state");
        Children("page", "groups", "group"); Children("group", "results", "title");
        foreach (var schema in new[] { "title", "episode", "season", "media", "calendar", "request" })
        {
            Children(schema, "jeSpoiler", "flags"); Children(schema, "blocked", "block");
        }
        foreach (var schema in new[] { "title", "episode", "season" })
        {
            Children(schema, "images", "images");
            Children(schema, "networks genres productionCountries productionCompanies spokenLanguages", "named");
            Children(schema, "credits aggregateCredits", "credits", "all-cast");
            Children(schema, "cast crew createdBy", "person", "all-cast"); Children(schema, "guestStars", "person", "cast");
            Children(schema, "keywords tags", "keywords", "tags");
            Children(schema, "reviews", "reviews", "reviews"); Children(schema, "videos relatedVideos", "videos", "plot");
            Children(schema, "externalIds", "external_ids"); Children(schema, "contentRatings", "content_ratings");
            Children(schema, "watch/providers watchProviders", "watch/providers");
            Children(schema, "release_dates releaseDates releases", "release_dates", "dates");
            Children(schema, "translations", "translations");
            Children(schema, "recommendations similar", "page", kind:null, surface:"recommendations");
            Children(schema, "episodes lastEpisodeToAir nextEpisodeToAir", "episode");
            Children(schema, "seasons", "season");
        }
        Children("title", "mediaInfo media", "media"); Children("title", "requestedBy modifiedBy", "user");
        Children("title", "parts", "title", kind:"movie");
        Children("title", "collection belongsToCollection", "collection");
        Children("title", "mineVariants", "variant"); Children("title", "mineSeasons", "number");
        Children("person", "knownFor", "title");
        Children("person", "roles jobs", "role"); Children("images", "profiles", "image");
        Children("media", "seasons", "media"); Children("media", "requests", "request");
        Children("media", "downloadStatus downloadStatus4k", "download");
        Children("request", "media", "media"); Children("request", "seasons", "media");
        Children("request", "requestedBy modifiedBy", "user");
        Children("credits", "cast crew", "person", "all-cast"); Children("credits", "guestStars", "person", "cast");
        foreach (var (field, policy) in new[] { ("posters","Primary"),("backdrops","Backdrop"),("stills","Screenshot"),("logos","Logo") })
        {
            var artworkPolicy = field == "stills" ? "episode-art:"+policy : "art:"+policy;
            Children("images", field, "image", artworkPolicy);
            foreach(var schema in new[]{"title","episode","season"}) Children(schema,field,"image",artworkPolicy);
        }
        Children("videos", "results", "video", "plot");
        Children("keywords", "keywords results", "named", "tags");
        Children("reviews", "results", "review", "reviews"); Children("review", "authorDetails", "review");
        Children("release_dates", "results", "release", "dates"); Children("release", "releaseDates", "release", "dates");
        Children("content_ratings", "results", "content_ratings");
        Children("watch/providers", "results", "countries");
        Children("providers", "flatrate rent buy ads free", "provider");
        Children("inbox", "items", "notification"); Children("notification", "params", "notification-params");
        Children("activity", "items", "activity-row"); Children("activity-row", "item", "activity-item");
        Children("user-reviews", "reviews", "user-review", "reviews");
        Children("review-ratings", "ratings", "review-rating-map");
        Children("translations", "translations", "translation"); Children("translation", "data", "translation-data");
        Children("ratings", "rt imdb tmdb metacritic rottenTomatoes ratings", "score", "ratings");
        Add("status", Role.Metadata, "key liveKey itemId openItemId kind versions stage attention quiet askedSeasons actions", "nextDate nextDay");
        Add("reason", Role.Metadata, "code"); Add("reason-params", Role.Metadata, "date count hours title contact library variant held sent since pct eta");
        Add("progress", Role.Metadata, "percent etaSeconds");
        Add("journey", Role.Metadata, "stage at state byYou");
        Add("status-summary", Role.Metadata, "aired ready downloading almostReady missing attention longMissing longMissingSince longMissingSent nextAirIsDay unknown nextSeason nextEpisode readySeasons", "nextAir");
        Add("season-status", Role.Metadata, "season itemId stage");
        Add("episode-status", Role.Metadata, "key season episode itemId row stage attention", "airDate");
        Add("admin-status", Role.Metadata, "unreadable approvedNotInArrSince approvedNotIn4k");
        Add("admin-variant", Role.Metadata, "instance instanceId kind role stage attention monitored hasFile minimumAvailability library itemId visibleToViewer messages arrState client quality customFormatScore path since fix scope lastSearch");
        Add("requester", Role.Person, "name role"); Add("quota", Role.Metadata, "used limit available");
        Add("space", Role.Metadata, "library freeGb");
        Add("request-admin", Role.Metadata, "reason"); Add("job", Role.Metadata, "id state attempts reason");
        Add("variant", Role.Metadata, "edition request"); Add("number", Role.Metadata, "");
        Add("download", Role.Metadata, "id status size sizeLeft timeLeft estimatedCompletionTime");
        // Collection identity is not a movie identity; only its member rows own title policy.
        Add("collection", Role.Metadata, "id name title originalLanguage originalName overview posterPath backdropPath");
        Children("collection", "parts", "title", kind:"movie");
        Add("season-rows", Role.Title, "key series season seriesId displayMissing canRequest seasonRequest");
        Children("season-rows", "episodes", "episode"); Children("season-rows", "blocked", "block");
        schemas["page"].Fields["rows"] = new(Disposition.Project, "season-rows");
        foreach (var field in new[] { "character", "job", "department" })
            foreach (var schema in new[] { "person", "role" }) schemas[schema].Fields[field] = new(Disposition.Project, Policy: "cast");
        foreach (var field in new[] { "voteaverage", "votecount" }) schemas["image"].Fields[field] = new(Disposition.Project, Policy: "ratings");
        Children("page", "recommendations similar", "page", surface:"recommendations");
        Children("title", "status partStatus", "status");
        Children("title", "reason", "reason");
        Children("title", "requester", "requester"); Children("requester", "quota", "quota");
        Children("title", "space", "space"); Children("title", "admin", "request-admin"); Children("request-admin", "jobs", "job");
        Children("status", "reason", "reason"); Children("status", "progress", "progress");
        Children("status", "journey", "journey"); Children("status", "summary", "status-summary");
        Children("status", "seasons", "season-status"); Children("status", "episodes", "episode-status"); Children("status", "admin", "admin-status");
        Children("season-status", "summary", "status-summary"); Children("episode-status", "reason", "reason"); Children("episode-status", "progress", "progress");
        Children("admin-status", "variants", "admin-variant"); Children("admin-variant", "reason", "reason"); Children("admin-variant", "progress", "progress");
        Children("reason", "params", "reason-params");
        foreach(var field in "scope variant createdAt updatedAt canCancel cancelIds declineReason stuck okd cost estimateGb already4k already4kIn canApprove canSwitchVariant released mediaStatus requestStatus requestedByAvatar jellyfinMediaId tvdbId isComingSoon isOrphaned alsoWanted".Split(' '))
            schemas["title"].Fields[Key(field)] = new(Disposition.Allow);
        void Policy(string schema, string fields, string policy)
        {
            foreach (var field in fields.Split(' ', StringSplitOptions.RemoveEmptyEntries))
                schemas[schema].Fields[Key(field)] = new(Disposition.Project, Policy: policy);
        }
        foreach (var schema in new[] { "title", "episode", "season", "translation-data" })
        {
            Policy(schema, "overview description summary plot", "overview");
            Policy(schema, "tagline taglines", "taglines");
            Policy(schema, "voteAverage voteCount rating ratings communityRating criticRating awards", "ratings");
            Policy(schema, "releaseDate releaseDateLocal airDateUtc date digitalRelease physicalRelease inCinemas physicalReleaseNote firstAirDate lastAirDate airDate nextAirDate nextDate nextDay digitalReleaseDate theatricalReleaseDate initialAirDate", "dates");
            Policy(schema, "character job department", "cast");
            Policy(schema, "posterPath posterUrl poster", "art:Primary");
            Policy(schema, "backdropPath backdropUrl backdrop", "art:Backdrop");
            Policy(schema, "logoPath logoUrl logo", "art:Logo");
            Policy(schema, "stillPath still", "episode-art:Screenshot");
            Policy(schema, "content", "reviews");
        }
        Children("ratings", "awards", "award", "ratings"); Children("ratings", "ids", "rating-ids");
        Children("title", "ratings", "ratings", "ratings"); Children("title", "awards", "award", "ratings");
        Policy("translation-data", "title name", "scoped-title");
        Policy("episode", "name title originalName originalTitle", "episode-title");
        Policy("calendar", "overview", "calendar-overview");
        Policy("calendar", "subtitle", "episode-subtitle");
        Policy("calendar", "episodeTitle episodeName", "episode-title");
        Policy("calendar", "releaseDate releaseDateLocal airDateUtc airDate digitalRelease physicalRelease inCinemas", "dates");
        Policy("calendar", "posterUrl", "series-art:Primary"); Policy("calendar", "backdropUrl", "series-art:Backdrop");
        Policy("status", "nextDate nextDay", "dates"); Policy("status-summary", "nextAir", "dates"); Policy("episode-status", "airDate", "dates");
        foreach (var schema in new[] { "review", "activity-row", "user-review" })
        { Policy(schema, "rating", "ratings"); Policy(schema, "content", "reviews"); }
        Policy("user-reviews", "averageRating", "ratings");
        Policy("release", "releaseDate", "dates");
        Add("calendar-page", Role.Envelope, "");
        foreach (var field in schemas["page"].Fields) schemas["calendar-page"].Fields[field.Key] = field.Value;
        Children("calendar-page", "results items events", "calendar"); Children("calendar-page", "errors", "provider-error");
        void Clone(string name, string source, Role? role = null)
            => schemas[name] = new(role ?? schemas[source].Role, new(schemas[source].Fields, StringComparer.Ordinal));
        Clone("approval-row", "title"); Clone("request-mine-row", "title");
        Clone("hub-row", "title"); Clone("arr-request-row", "title");
        Add("request-coordinate", Role.Metadata, "season episode");
        Add("parental-assessment", Role.Metadata, "label within");
        schemas["approval-row"].Fields["overquota"] = new(Disposition.Allow);
        Children("approval-row", "rating", "parental-assessment");
        foreach (var name in new[] { "approval-row", "request-mine-row", "hub-row" })
        {
            // Requested scope is operational data, not provider season/episode descriptions.
            Children(name, "episodes", "request-coordinate");
            Children(name, "seasons", "number");
        }
        schemas["request-mine-row"].Fields["status"] = new(Disposition.Allow);
        schemas["arr-request-row"].Fields["requestedby"] = new(Disposition.Allow);
        Clone("ledger-row", "request-mine-row");
        schemas["ledger-row"].Fields["requesterid"] = new(Disposition.Allow);
        Add("ledger-member", Role.Metadata, "id status reason");
        Children("ledger-row", "jobs", "job"); Children("ledger-row", "members", "ledger-member");
        Children("ledger-member", "jobs", "job");
        foreach (var (name, row) in new[] { ("approvals", "approval-row"), ("request-mine", "request-mine-row"),
            ("requests-hub", "hub-row"), ("arr-requests", "arr-request-row"), ("request-ledger", "ledger-row") })
        {
            Clone(name, "page");
            Children(name, "items requests mine soon ready", row);
        }
        Clone("status-row", "status", Role.Title);
        Children("status-row", "jeSpoiler", "flags");
        Clone("status-page", "page"); Children("status-page", "items", "status-row");
        return schemas;
    }

    /// <summary>Only resources with declared adapters may be sent through the raw TMDB proxy.</summary>
    public static bool SupportsTmdbPath(string path)
    {
        var p=path.Trim('/').Split('/');
        static bool Id(string value) => int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var id) && id>0;
        if(p.Length==2 && p[0]=="search" && p[1] is "movie" or "tv" or "multi" or "person" or "keyword" or "company") return true;
        if(p.Length==2 && p[0]=="discover" && p[1] is "movie" or "tv") return true;
        if(p.Length==3 && p[0]=="trending" && p[1] is "movie" or "tv" or "all" or "person" && p[2] is "day" or "week") return true;
        if(p.Length==3 && p[0]=="genre" && p[1] is "movie" or "tv" && p[2]=="list") return true;
        if(p.Length<2 || !Id(p[1])) return false;
        if(p[0]=="person") return p.Length==2 || p.Length==3 && p[2] is "combined_credits" or "movie_credits" or "tv_credits" or "images" or "external_ids" or "translations";
        if(p[0]=="collection") return p.Length==2 || p.Length==3 && p[2] is "images" or "translations";
        if(p[0] is "keyword" or "company" or "network") return p.Length==2;
        if(p[0] is not ("movie" or "tv")) return false;
        var at=2;
        if(p[0]=="tv" && p.Length>=4 && p[2]=="season" && int.TryParse(p[3],out var s) && s>=0) at=4;
        if(at==4 && p.Length>=6 && p[4]=="episode" && Id(p[5])) at=6;
        if(p.Length==at) return true;
        return TmdbAppendProjection.Envelopes.Append("translations").Any(resource=>string.Join('/',p.Skip(at))==resource);
    }

    internal static string? LookupResource(string path)
    {
        var p=path.Trim('/').Split('/');
        if(p.Length==2 && p[0]=="search") return p[1] switch { "person"=>"mixed-search", "company" or "keyword"=>"named-search", _=>null };
        if(p.Length==2 && p[0] is "person" or "collection") return p[0];
        if(p.Length==2 && p[0] is "company" or "network" or "keyword") return "named";
        if(p.Length==2 && p[0]=="genres" || p.Length==3 && p[0]=="genre" && p[2]=="list") return "named-lookup";
        return null;
    }

    /// <summary>Maps a known provider route to its declared response resource, independent of payload fields.</summary>
    internal static string ProviderResource(string path)
    {
        var p = path.Split('?', 2)[0].Trim('/').Split('/');
        if (p.Length >= 2 && p[0] == "api" && p[1] == "v1") p = p.Skip(2).ToArray();
        // Seerr TV ratings are one flat score, unlike movie ratingscombined or MDBList.
        if (p.Length == 3 && p[0] == "tv" && p[2] == "ratings") return "tv-ratings";
        var lookup = LookupResource(string.Join('/', p));
        if (lookup != null) return lookup;
        if (p.Length >= 2 && p[^2] == "watch" && p[^1] == "providers") return "watch/providers";
        var last = p.LastOrDefault() ?? "";
        if (last is "credits" or "aggregate_credits" or "combined_credits" or "movie_credits" or "tv_credits"
            or "ratings" or "ratingscombined" or "awards" or "images" or "videos" or "keywords" or "reviews"
            or "content_ratings" or "external_ids" or "translations" or "release_dates" or "releases"
            or "recommendations" or "similar" or "filmography") return last;
        if (p.Length >= 2 && p[0] is "movie" or "tv" && int.TryParse(p[1], out _))
            return p.Contains("episode") ? "episode" : p.Contains("season") ? "season" : "title";
        return "page"; // Declared provider list routes (discover, search, watchlist and request).
    }

    /// <summary>Projects a private tree with resource-selected roles. Unknown guarded fields are removed recursively.</summary>
    public static string Project(string json, HiddenContentPolicy? hidden, SpoilerPresentationContext? spoilers, string surface,
        string? title, string resource, string? kind=null, string? scope=null, int season=0, int episode=0)
    {
        var root=JsonNode.Parse(json);
        if (spoilers?.Enabled == false) spoilers = null;
        kind ??= title?.StartsWith("movie:", StringComparison.Ordinal) == true ? "movie" : title != null ? "tv" : null;
        ArgumentException.ThrowIfNullOrEmpty(resource);
        kind = resource switch { "movie_credits" => "movie", "tv_credits" => "tv", _ => kind };
        var schema=Resource(resource,root,title,scope);
        root=Walk(root,schema,title,kind,scope,season,episode,surface,hidden,spoilers,ownIdentity:false,filter:false,containsGuarded:out _);
        return root?.ToJsonString()??"null";
    }

    private static string Resource(string resource, JsonNode? root, string? title, string? scope)
        => resource switch {
            "credits" or "aggregate_credits"=>"credits",
            "combined_credits" or "movie_credits" or "tv_credits" or "filmography" or "recommendations" or "similar" or "mixed-search"=>"page",
            "season-rows"=>"season-rows",
            "ratings" or "ratingscombined" or "awards"=>"ratings",
            "tv-ratings"=>"score",
            "images" or "videos" or "keywords" or "reviews" or "content_ratings" or "external_ids" or "translations"=>resource,
            "watch/providers" or "providers"=>root is JsonArray ? "seerr-provider-country" : "watch/providers",
            "release_dates" or "releases"=>"release_dates",
            "inbox" or "activity" or "activity-row" or "user-reviews" or "review-ratings" => resource,
            "person-search" or "named-search" or "named-lookup" or "named" => resource,
            "person"=>"person", "collection"=>"collection", "calendar"=>root is JsonArray ? "calendar" : "calendar-page",
            "approvals" or "request-mine" or "requests-hub" or "arr-requests" or "request-ledger" or "status-page" => resource,
            "title" => scope is "episode" or "season" ? scope : "title",
            "episode" or "season" or "page" => resource,
            _ => throw new ArgumentException("A declared presentation resource is required.", nameof(resource))
        };

    private static JsonNode? Walk(JsonNode? node,string schemaName,string? title,string? kind,string? scope,int season,int episode,
        string surface,HiddenContentPolicy? hidden,SpoilerPresentationContext? spoilers,bool ownIdentity,bool filter,out bool containsGuarded)
    {
        containsGuarded = spoilers?.Guarded(title) == true;
        // A ratings role suppresses the whole value, including scalar and array responses.
        if (Schemas[schemaName].Role == Role.Ratings && spoilers?.HidesRatings(title) == true)
        { containsGuarded = true; return null; }
        if(node is JsonArray rows)
        {
            for(var i=rows.Count-1;i>=0;i--)
            {
                var projected=Walk(rows[i],schemaName,title,kind,scope,season,episode,surface,hidden,spoilers,ownIdentity || OwnsTitle(schemaName),filter:true,containsGuarded:out var childGuarded);
                containsGuarded |= childGuarded;
                if(projected==null) rows.RemoveAt(i);
                else if(!ReferenceEquals(projected,rows[i])) rows[i]=projected;
            }
            return rows;
        }
        if(node is not JsonObject row) return node;
        // A declared mixed-search union uses its provider discriminator; person IDs never enter title policy.
        if (ownIdentity && schemaName == "title" && (row["mediaType"] ?? row["media_type"])?.ToString() == "person")
        { schemaName = "person"; title = null; }
        var schema=Schemas[schemaName];
        if(schema.Role == Role.Title)
        {
            if(ownIdentity || title==null) title=TitleFeedProjection.Identity(row,kind);
            containsGuarded = spoilers?.Guarded(title) == true;
            if(schemaName=="group" && row["results"] is JsonArray { Count:0 }) return null;
            if(filter && schemaName != "status-row" && hidden!=null && Hidden(row,title,hidden,surface)) return null;
            kind=title?.StartsWith("movie:",StringComparison.Ordinal)==true?"movie":title!=null?"tv":kind;
        }
        if(schema.Role==Role.Notification) title=TitleFeedProjection.Identity(row);
        var guarded=spoilers?.Guarded(title)==true;
        containsGuarded = guarded;
        if(schema.Role==Role.Notification && (guarded || hidden!=null && Hidden(row,title,hidden,surface)))
        {
            row["key"]=null; row["itemId"]=null; row["link"]=null;
            if(row["params"] is JsonObject parameters)
                foreach(var field in new[]{"title","year","poster","image"}) parameters.Remove(field);
        }
        if(schema.Role==Role.Ratings && spoilers?.HidesRatings(title)==true) return null;
        var effectiveKind=schema.Role==Role.Episode?"episode":schema.Role==Role.Season?"season":scope??kind??"tv";
        season=Number(row,"seasonNumber",season);episode=Number(row,"episodeNumber",episode);
        if(title!=null && spoilers!=null && schema.Role is Role.Title or Role.Episode or Role.Season or Role.Text)
            spoilers.AddNavigationMetadata(row,title,schemaName=="calendar" && kind=="tv"?"episode":effectiveKind,season,episode);
        foreach(var pair in row.ToArray())
        {
            if(!schema.Fields.TryGetValue(Key(pair.Key),out var field))
            {
                if(schemaName=="review-rating-map" && RatingOwner(pair.Key,out var ratingKind) is { } owner)
                {
                    row[pair.Key]=Walk(pair.Value,"review-rating",owner,ratingKind,null,0,0,surface,hidden,spoilers,false,false,out var childGuarded);
                    containsGuarded |= childGuarded;
                }
                else if(schema.Countries && pair.Key.Length==2 && pair.Key.All(c=>c is >= 'A' and <= 'Z'))
                {
                    row[pair.Key]=Walk(pair.Value,"providers",title,kind,scope,season,episode,surface,hidden,spoilers,false,false,out var childGuarded);
                    containsGuarded |= childGuarded;
                }
                else if(guarded) row.Remove(pair.Key);
                continue;
            }
            if(!guarded && field.Child==null) continue;
            if(guarded && field.Disposition==Disposition.Remove) { row.Remove(pair.Key);continue; }
            if(guarded && field.Policy!=null && spoilers!=null && Suppress(field.Policy,spoilers,title,effectiveKind,season))
            {
                if(field.Policy=="episode-title" && schema.Role==Role.Episode && Key(pair.Key)=="name") row[pair.Key]="";
                else if(field.Policy=="episode-subtitle") row[pair.Key]=string.Create(CultureInfo.InvariantCulture,$"S{season:00}E{episode:00}");
                else if(pair.Value is JsonArray && field.Child!=null && field.Policy is not ("cast" or "all-cast")) row[pair.Key]=new JsonArray();
                else row.Remove(pair.Key);
                continue;
            }
            if(field.Child!=null)
            {
                // Seerr uses direct arrays for keywords/videos as well as TMDB's resource envelopes.
                var childSchema=pair.Value is JsonArray ? field.Child switch {
                    "keywords"=>"named", "videos"=>"video", "watch/providers"=>"seerr-provider-country", _=>field.Child } : field.Child;
                var childScope=childSchema is "episode" or "season"?childSchema:scope;
                var own=OwnsTitle(childSchema) || childSchema=="page" && field.Surface!=null;
                // Related pages contain independent titles; person/metadata IDs never select a title policy.
                var childTitle=field.Surface!=null?null:title;
                var projected=Walk(pair.Value,childSchema,childTitle,field.Kind??kind,childScope,season,episode,field.Surface??surface,hidden,spoilers,own,false,out var childGuarded);
                containsGuarded |= childGuarded;
                if(!ReferenceEquals(projected,pair.Value)) row[pair.Key]=projected;
            }
            else if(guarded && pair.Value is JsonObject or JsonArray)
            {
                // A scalar/primitive-array declaration cannot smuggle an unclassified nested envelope.
                if(pair.Value is JsonObject || pair.Value is JsonArray array && array.Any(n=>n is JsonObject or JsonArray)) row.Remove(pair.Key);
            }
        }
        if (schema.Role == Role.Envelope && containsGuarded)
        {
            // An envelope has no independent title. Its known children establish whether it contains guarded content.
            foreach (var pair in row.ToArray())
            {
                if (!schema.Fields.TryGetValue(Key(pair.Key), out var declared))
                {
                    if (schemaName == "review-rating-map" && RatingOwner(pair.Key, out _) != null) continue;
                    row.Remove(pair.Key);
                }
                else if (declared.Child == null && (pair.Value is JsonObject || pair.Value is JsonArray values && values.Any(v => v is JsonObject or JsonArray)))
                    row.Remove(pair.Key);
            }
        }
        if(schemaName=="group" && row["results"] is JsonArray { Count:0 }) return null;
        return row;
    }

    /// <summary>A "mediaType:tmdbKey" rating-map entry's owning title, through the canonical parser.</summary>
    private static string? RatingOwner(string key, out string kind)
    {
        var sep = key.IndexOf(':');
        kind = sep > 0 ? key[..sep] : "";
        return sep > 0 ? HiddenContentPolicy.OwningTitle(kind, key[(sep + 1)..]) : null;
    }

    private static bool OwnsTitle(string schema)
        => schema is "title" or "calendar" or "group" or "approval-row" or "request-mine-row" or "hub-row" or "arr-request-row" or "ledger-row" or "status-row";

    private static bool Suppress(string policy,SpoilerPresentationContext spoilers,string? title,string kind,int season)
        => policy switch {
            "calendar-overview" => spoilers.Suppresses(title,"overview",kind=="tv"?"episode":kind,season),
            "scoped-title" => kind=="episode" && spoilers.MissingRow(title).Title,
            "episode-title" or "episode-subtitle" => spoilers.MissingRow(title).Title,
            _ when policy.StartsWith("episode-art:",StringComparison.Ordinal) => spoilers.ProtectArtwork(title,"episode",policy[12..],season),
            _ when policy.StartsWith("series-art:",StringComparison.Ordinal) => spoilers.ProtectArtwork(title,kind,policy[11..],season),
            _ when policy.StartsWith("art:",StringComparison.Ordinal) => spoilers.ProtectArtwork(title,kind,policy[4..],season),
            _ => spoilers.Suppresses(title,policy,kind,season)
        };
    private static bool Hidden(JsonObject row,string? title,HiddenContentPolicy policy,string surface)
    {
        var media=row["mediaInfo"] as JsonObject??row["media"] as JsonObject;
        return policy.IsHidden(title,Text(row,"itemId")??Text(row,"jellyfinMediaId")??(media==null?null:Text(media,"jellyfinMediaId")),null,surface)
            || media!=null && policy.IsHidden(null,Text(media,"jellyfinMediaId4k"),null,surface);
    }
    private static string? Text(JsonObject row,string name)=>row[name] is JsonValue v?v.ToString():null;
    private static int Number(JsonObject row,string name,int fallback)=>int.TryParse((row[name]??row[System.Text.Json.JsonNamingPolicy.SnakeCaseLower.ConvertName(name)])?.ToString(),out var n)?n:fallback;
}
