using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// What one provider answer is worth (review round 7, D53: ONE response contract per resource kind): Valid answers are
    /// definitive (cacheable, and may prove an absence or clear a stored value); Partial answers are usable but never
    /// cached, never proof that something is absent and never clear a stored value; Malformed answers are a failure
    /// (transient: the next server is asked).
    /// </summary>
    public enum ResponseVerdict
    {
        /// <summary>Every declared field is as declared: definitive.</summary>
        Valid,

        /// <summary>Usable, but a fact is unknown (a field missing) or a display field is unreadable: never kept, never proof.</summary>
        Partial,

        /// <summary>A required or fact-bearing field is missing, null or of the wrong type: a failure.</summary>
        Malformed,
    }

    /// <summary>
    /// The type a declared field must have: its JSON type AND a value its consumers can use (review round 8, D53: one parser
    /// per type, the one every consumer uses; a value of the right JSON type that the parser refuses is unusable).
    /// </summary>
    internal enum FieldType
    {
        /// <summary>A positive 32-bit integer (a TMDB or TVDB id). 0 is empty; a negative, fractional or larger number is unusable.</summary>
        Id,

        /// <summary>A non-negative 32-bit integer (a season or episode number, a count); a negative or fractional one is unusable.</summary>
        Count,

        /// <summary>Any number.</summary>
        Number,

        /// <summary>A string, read as cleaned text (control characters dropped, trimmed); "" is empty.</summary>
        Text,

        /// <summary>A boolean.</summary>
        Bool,

        /// <summary>An IMDb title id (<c>tt</c> + 5–10 digits); "" is empty; any other string is unusable.</summary>
        Imdb,

        /// <summary>A date (<c>yyyy-MM-dd</c>, or an ISO date-time read as its date); "" is empty (TBA); any other string is unusable.</summary>
        Date,

        /// <summary>A TMDB image path (<c>/name.jpg</c> or <c>.png</c>); "" is empty; any other string (a URL, a relative path) is unusable.</summary>
        Poster,

        /// <summary>An object with its own declared members.</summary>
        Object,

        /// <summary>A list of rows with their own declared fields.</summary>
        List,
    }

    /// <summary>What a field means to the answer, i.e. what its absence or a bad value does to the verdict.</summary>
    internal enum FieldRole
    {
        /// <summary>The resource itself (its id, its title, its result list): missing, null, empty or wrong → Malformed.</summary>
        Required,

        /// <summary>
        /// An external id of the title (one source of an identity fact): missing → the fact is unknown (Partial unless
        /// another source of the same fact proves it); an explicit null or empty value → proven absent (Valid); a wrong
        /// type or a value that isn't an id → Malformed.
        /// </summary>
        Identity,

        /// <summary>
        /// A fact a consumer derives something from (a season list, a release date, a production state): missing → unknown
        /// (Partial); null → proven absent when nullable, else Malformed; a wrong type → Malformed.
        /// </summary>
        Fact,

        /// <summary>Shown or scored only: missing, null or empty → no value; a wrong type → Partial (the value is dropped).</summary>
        Display,

        /// <summary>
        /// An optional object whose members are declared (external ids, the last aired episode): missing → its members are
        /// unknown; null → none when nullable, else Malformed; a wrong type → Malformed; present → its members are read.
        /// </summary>
        Container,
    }

    /// <summary>What a row of a list that JE can't read does to the answer.</summary>
    internal enum RowFailure
    {
        /// <summary>The list is incomplete: the answer is Partial (the rows read are used; nothing usable → Malformed).</summary>
        Partial,

        /// <summary>The list is the resource itself: the answer is Malformed.</summary>
        Malformed,
    }

    /// <summary>One declared field.</summary>
    /// <param name="Name">JSON property name.</param>
    /// <param name="Type">Its type.</param>
    /// <param name="Role">Its role.</param>
    /// <param name="Nullable">An explicit null is a value (proven absent) rather than a bad value (facts and containers).</param>
    /// <param name="Members">Object members or list rows.</param>
    /// <param name="Rows">What an unreadable row does (lists).</param>
    /// <param name="Fact">The identity fact an <see cref="FieldRole.Identity"/> field is a source of ("imdb", "tvdb").</param>
    /// <param name="Echo">The request fact this field must equal when the request names it (review round 9): another value is
    /// an answer to another request (another title, season or show), so the row or answer is Malformed.</param>
    /// <param name="Unique">Lists: the member names that key a row (two usable rows with the same key make the answer
    /// Malformed); an empty key means the list holds at most one row (more is ambiguous: Malformed).</param>
    internal sealed record FieldRule(string Name, FieldType Type, FieldRole Role, bool Nullable = true, ResourceSchema? Members = null, RowFailure Rows = RowFailure.Malformed, string? Fact = null,
        RequestFact Echo = RequestFact.None, IReadOnlyList<string>? Unique = null);

    /// <summary>A fact of the request an answer must echo (review round 9, D53: an answer is checked against the request that produced it).</summary>
    internal enum RequestFact
    {
        /// <summary>Not a request fact.</summary>
        None,

        /// <summary>The TMDB id asked for (details, a <c>tmdb:N</c> title, a collection).</summary>
        Id,

        /// <summary>The media type asked for (<c>movie</c> or <c>tv</c>).</summary>
        MediaType,

        /// <summary>The season asked for.</summary>
        Season,

        /// <summary>The show a season was asked of.</summary>
        Show,

        /// <summary>The page asked for.</summary>
        Page,
    }

    /// <summary>
    /// What an answer was asked for (review round 9, D53 "contracts take the request"): the identity (TMDB id, media type), the
    /// season (and its show) and the page the request named. A field declared to echo one of these must equal it; an answer
    /// that doesn't is another resource's, so it is Malformed: never used, kept, proof of an absence, or allowed to clear a
    /// stored value.
    /// </summary>
    /// <param name="Id">The TMDB id asked for.</param>
    /// <param name="MediaType">"movie" or "tv".</param>
    /// <param name="Season">The season number asked for.</param>
    /// <param name="Show">The show's TMDB id a season was asked of.</param>
    /// <param name="Page">The page asked for.</param>
    internal sealed record AnswerRequest(int? Id = null, string? MediaType = null, int? Season = null, int? Show = null, int? Page = null)
    {
        /// <summary>A request that names nothing (a row read on its own).</summary>
        public static readonly AnswerRequest None = new();

        /// <summary>The value of a request fact, or null when the request doesn't name it.</summary>
        /// <param name="fact">The fact.</param>
        /// <returns>The value.</returns>
        public object? Of(RequestFact fact) => fact switch
        {
            RequestFact.Id => Id,
            RequestFact.MediaType => MediaType,
            RequestFact.Season => Season,
            RequestFact.Show => Show,
            RequestFact.Page => Page,
            _ => null,
        };
    }

    /// <summary>
    /// A page's paging fields (review round 9, D53 domain rules): the page number (echoes the page asked for), the page count
    /// and the total are non-negative, and consistent with the rows: a total of at least the page's rows, and a page count of
    /// at least 1 when there is a total. A violation makes the answer Partial (its rows are still titles, but it is never
    /// kept and never proves "no titles").
    /// </summary>
    /// <param name="Page">The page number's field.</param>
    /// <param name="Pages">The page count's field.</param>
    /// <param name="Total">The total's field.</param>
    /// <param name="Rows">The rows' list field.</param>
    internal sealed record PagingRule(string Page, string Pages, string Total, string Rows);

    /// <summary>The state of one identity fact of an answer.</summary>
    internal enum FactState
    {
        /// <summary>No source said anything about it.</summary>
        Unknown,

        /// <summary>A source said there is none (an explicit null or empty value).</summary>
        Absent,

        /// <summary>A source gave the value.</summary>
        Known,
    }

    /// <summary>A declared resource schema: its fields and the identity facts it must establish.</summary>
    /// <param name="Name">Resource kind (diagnostics, tests).</param>
    /// <param name="Fields">Declared fields (undeclared fields are ignored).</param>
    /// <param name="Facts">Identity facts the answer must establish to be Valid (each Known or Absent).</param>
    /// <param name="Paging">The page's paging fields, when the answer is a page.</param>
    internal sealed record ResourceSchema(string Name, IReadOnlyList<FieldRule> Fields, IReadOnlyList<string>? Facts = null, PagingRule? Paging = null)
    {
        /// <summary>The same schema in Seerr's names (camelCase), e.g. <c>external_ids.imdb_id</c> → <c>externalIds.imdbId</c>.</summary>
        /// <param name="name">The camelCase schema's name.</param>
        /// <returns>The schema.</returns>
        public ResourceSchema Camel(string name) => new(
            name,
            Fields.Select(f => f with { Name = ResponseContract.CamelName(f.Name), Members = f.Members?.Camel(f.Members.Name), Unique = f.Unique?.Select(ResponseContract.CamelName).ToList() }).ToList(),
            Facts,
            Paging == null ? null : new PagingRule(ResponseContract.CamelName(Paging.Page), ResponseContract.CamelName(Paging.Pages), ResponseContract.CamelName(Paging.Total), ResponseContract.CamelName(Paging.Rows)));

        /// <summary>This schema with more fields (another resource built on it).</summary>
        /// <param name="name">The new schema's name.</param>
        /// <param name="fields">Fields added.</param>
        /// <param name="facts">Identity facts.</param>
        /// <returns>The schema.</returns>
        public ResourceSchema With(string name, IEnumerable<FieldRule> fields, IReadOnlyList<string>? facts = null) => new(name, Fields.Concat(fields).ToList(), facts ?? Facts, Paging);

        /// <summary>Validates an answer (or one row) on its own, against no request.</summary>
        /// <param name="element">The answer.</param>
        /// <returns>The verdict and the identity facts.</returns>
        public ContractRead Read(JsonElement element) => ResponseContract.Validate(this, AnswerRequest.None, element);

        /// <summary>Validates an answer against this schema AND the request that produced it (review round 9).</summary>
        /// <param name="request">What was asked for.</param>
        /// <param name="element">The answer.</param>
        /// <returns>The verdict and the identity facts.</returns>
        public ContractRead Validate(AnswerRequest request, JsonElement element) => ResponseContract.Validate(this, request, element);
    }

    /// <summary>
    /// One answer (or one object or row of it) as the contract read it: its verdict, the state of each identity fact, and
    /// the TYPED value of every declared field that held a usable one (review round 8, D53 "parse once into typed facts":
    /// consumers take these values and never read the JSON again). A field that was missing, null, empty or unusable has
    /// no value. A container's members are read as their own <see cref="ContractRead"/> (<see cref="Member"/>), and so is
    /// each usable row of a declared list (<see cref="Rows"/>).
    /// </summary>
    internal sealed class ContractRead
    {
        private readonly Dictionary<string, FactState> _facts = new(StringComparer.Ordinal);
        private readonly Dictionary<string, (FieldType Type, object Value)> _values = new(StringComparer.Ordinal);

        /// <summary>The verdict.</summary>
        public ResponseVerdict Verdict { get; private set; } = ResponseVerdict.Valid;

        /// <summary>Why the verdict isn't Valid (a bounded diagnostic: the field path), or null.</summary>
        public string? Reason { get; private set; }

        /// <summary>The state of an identity fact (Unknown when no source declared it).</summary>
        /// <param name="fact">Fact name.</param>
        /// <returns>The state.</returns>
        public FactState Fact(string fact) => _facts.TryGetValue(fact, out var state) ? state : FactState.Unknown;

        /// <summary>Lowers the verdict (never raises it).</summary>
        /// <param name="verdict">The verdict of a field.</param>
        /// <param name="reason">Field path.</param>
        public void Lower(ResponseVerdict verdict, string reason)
        {
            if (verdict > Verdict)
            {
                Verdict = verdict;
                Reason = reason;
            }
        }

        /// <summary>A text field's cleaned value, or null.</summary>
        /// <param name="name">Field name.</param>
        /// <returns>The value.</returns>
        public string? Text(string name) => Value<string>(name, FieldType.Text);

        /// <summary>A date field's value (<c>yyyy-MM-dd</c>), or null.</summary>
        /// <param name="name">Field name.</param>
        /// <returns>The value.</returns>
        public string? Date(string name) => Value<string>(name, FieldType.Date);

        /// <summary>A poster field's value (a TMDB image path), or null.</summary>
        /// <param name="name">Field name.</param>
        /// <returns>The value.</returns>
        public string? Poster(string name) => Value<string>(name, FieldType.Poster);

        /// <summary>An IMDb id field's value, or null.</summary>
        /// <param name="name">Field name.</param>
        /// <returns>The value.</returns>
        public string? Imdb(string name) => Value<string>(name, FieldType.Imdb);

        /// <summary>An id or count field's value, or null.</summary>
        /// <param name="name">Field name.</param>
        /// <returns>The value.</returns>
        public int? Int(string name) => _values.TryGetValue(name, out var v) && v.Type is FieldType.Id or FieldType.Count ? (int)v.Value : null;

        /// <summary>A number field's value, or null.</summary>
        /// <param name="name">Field name.</param>
        /// <returns>The value.</returns>
        public double? Number(string name) => _values.TryGetValue(name, out var v) && v.Type == FieldType.Number ? (double)v.Value : null;

        /// <summary>A boolean field's value, or null.</summary>
        /// <param name="name">Field name.</param>
        /// <returns>The value.</returns>
        public bool? Bool(string name) => _values.TryGetValue(name, out var v) && v.Type == FieldType.Bool ? (bool)v.Value : null;

        /// <summary>A container's members as read, or null (missing, null or of the wrong type).</summary>
        /// <param name="name">Field name.</param>
        /// <returns>The members.</returns>
        public ContractRead? Member(string name) => Value<ContractRead>(name, FieldType.Object);

        /// <summary>The usable rows of a declared list, in order (none when the list is missing, null or of the wrong type).</summary>
        /// <param name="name">Field name.</param>
        /// <returns>The rows.</returns>
        public IReadOnlyList<ContractRead> Rows(string name) => Value<IReadOnlyList<ContractRead>>(name, FieldType.List) ?? Array.Empty<ContractRead>();

        /// <summary>A scalar field's typed value as text (a row's key), or null.</summary>
        /// <param name="name">Field name.</param>
        /// <returns>The value.</returns>
        public string? KeyOf(string name) => _values.TryGetValue(name, out var v) && v.Type is not (FieldType.Object or FieldType.List)
            ? Convert.ToString(v.Value, CultureInfo.InvariantCulture)
            : null;

        /// <summary>Records a field's typed value (the validator only).</summary>
        /// <param name="name">Field name.</param>
        /// <param name="type">Its type.</param>
        /// <param name="value">The parsed value.</param>
        public void Set(string name, FieldType type, object value) => _values[name] = (type, value);

        /// <summary>Adds what a source said about an identity fact (Known wins over Absent, Absent over Unknown).</summary>
        /// <param name="fact">Fact name.</param>
        /// <param name="state">The state.</param>
        public void Note(string fact, FactState state)
        {
            if (!_facts.TryGetValue(fact, out var current) || state > current)
            {
                _facts[fact] = state;
            }
        }

        private T? Value<T>(string name, FieldType type)
            where T : class => _values.TryGetValue(name, out var v) && v.Type == type ? v.Value as T : null;
    }

    /// <summary>
    /// The response contracts of every provider answer the list subsystem reads (review round 7, D53): one declared schema
    /// per resource kind, read by one validator. TMDB and Seerr title details, searches, <c>find</c> answers and seasons
    /// (the import lookups), and the placeholder-metadata resources (Seerr's, and TMDB's in Seerr's names for JE mode).
    /// List-source rows have their own per-provider row contract in the source fetcher's row readers (review rounds 4–5,
    /// 7): a row's key (its TMDB, IMDb or TVDB id; for Chronolists, an exact source, also its title) and declared type are
    /// required (missing, null, wrong type or empty: the row is malformed and the snapshot isn't complete); titles and
    /// years are display (unreadable: no value; a snapshot is complete by its keys). Review round 8 (D53, 4c2-R8-1): the
    /// contract parses once into TYPED facts with the one parser per type its consumers use (<see cref="ParseDate"/>,
    /// <see cref="ParsePoster"/>, positive ids, IMDb ids, cleaned text); consumers take only those values
    /// (<see cref="ContractRead"/>), and a value of the right JSON type that the parser refuses is unusable: a fact or display
    /// field then makes the answer Partial (never kept, never clears a stored value), a required field or an identity id
    /// Malformed.
    /// </summary>
    internal static class ResponseContract
    {
        private static readonly Regex ImdbRegex = new("^tt[0-9]{5,10}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex PosterRegex = new("^/[A-Za-z0-9_-]+\\.(jpg|png)$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

        /// <summary>How a present, non-null, non-empty value read by its declared type.</summary>
        private enum Parsed
        {
            /// <summary>Usable: its typed value is recorded.</summary>
            Ok,

            /// <summary>Not of the declared JSON type.</summary>
            WrongType,

            /// <summary>Of the declared JSON type, but not a value the consumers can use (a date that isn't one, a URL as a poster path, a negative id).</summary>
            Unusable,
        }

        private static FieldRule Required(string name, FieldType type, ResourceSchema? rows = null, RowFailure failure = RowFailure.Malformed, RequestFact echo = RequestFact.None, string[]? unique = null) =>
            new(name, type, FieldRole.Required, false, rows, failure, Echo: echo, Unique: unique);

        private static FieldRule Display(string name, FieldType type, RequestFact echo = RequestFact.None) => new(name, type, FieldRole.Display, Echo: echo);

        private static FieldRule Fact(string name, FieldType type, bool nullable = true, ResourceSchema? rows = null, string[]? unique = null) => new(name, type, FieldRole.Fact, nullable, rows, Unique: unique);

        private static FieldRule Identity(string name, FieldType type, string fact) => new(name, type, FieldRole.Identity, true, Fact: fact);

        private static FieldRule Container(string name, bool nullable, params FieldRule[] members) => new(name, FieldType.Object, FieldRole.Container, nullable, new ResourceSchema(name, members));

        // ── Import lookups (TMDB's names; Seerr's are the camelCase of the same) ──

        /// <summary>A movie row of a search or find answer (also the title part of movie details).</summary>
        public static readonly ResourceSchema TmdbMovieRow = new("tmdb movie row", new[]
        {
            Required("id", FieldType.Id, echo: RequestFact.Id), Display("media_type", FieldType.Text, RequestFact.MediaType), Required("title", FieldType.Text), Display("original_title", FieldType.Text),
            Display("release_date", FieldType.Date), Display("poster_path", FieldType.Poster), Display("overview", FieldType.Text),
            Display("popularity", FieldType.Number), Display("vote_count", FieldType.Count), Display("adult", FieldType.Bool),
        });

        /// <summary>A show row of a search or find answer (also the title part of TV details).</summary>
        public static readonly ResourceSchema TmdbTvRow = new("tmdb tv row", new[]
        {
            Required("id", FieldType.Id, echo: RequestFact.Id), Display("media_type", FieldType.Text, RequestFact.MediaType), Required("name", FieldType.Text), Display("original_name", FieldType.Text),
            Display("first_air_date", FieldType.Date), Display("poster_path", FieldType.Poster), Display("overview", FieldType.Text),
            Display("popularity", FieldType.Number), Display("vote_count", FieldType.Count), Display("adult", FieldType.Bool),
        });

        private static readonly ResourceSchema TmdbSeasonRow = new("tmdb season row", new[]
        {
            Required("season_number", FieldType.Count), Display("episode_count", FieldType.Count), Display("air_date", FieldType.Date), Display("name", FieldType.Text),
        });

        // An episode of the season asked for (review round 9, 4c2-R9-2: membership): its own season and show, where it names
        // them, are the request's.
        private static readonly ResourceSchema TmdbEpisodeRow = new("tmdb episode row", new[]
        {
            Required("episode_number", FieldType.Count), Display("season_number", FieldType.Count, RequestFact.Season), Display("show_id", FieldType.Id, RequestFact.Show),
            Display("name", FieldType.Text), Display("air_date", FieldType.Date),
        });

        private static readonly ResourceSchema TmdbEpisodeFindRow = new("tmdb episode find row", new[]
        {
            Required("show_id", FieldType.Id), Required("season_number", FieldType.Count), Required("episode_number", FieldType.Count),
            Display("name", FieldType.Text), Display("air_date", FieldType.Date),
        });

        /// <summary>
        /// TMDB movie details (with <c>append_to_response=external_ids</c>): the title, and its IMDb id from <c>imdb_id</c> or
        /// <c>external_ids.imdb_id</c> (an explicit null in either is TMDB's "none"; neither there is unknown).
        /// </summary>
        public static readonly ResourceSchema TmdbMovieDetails = TmdbMovieRow.With("tmdb movie details", new[]
        {
            Display("status", FieldType.Text), Identity("imdb_id", FieldType.Imdb, "imdb"),
            Container("external_ids", false, Identity("imdb_id", FieldType.Imdb, "imdb")),
        }, new[] { "imdb" });

        /// <summary>TMDB TV details: the title, its IMDb and TVDB ids (from <c>external_ids</c>) and its season list.</summary>
        public static readonly ResourceSchema TmdbTvDetails = TmdbTvRow.With("tmdb tv details", new[]
        {
            Display("status", FieldType.Text), Display("in_production", FieldType.Bool),
            Container("external_ids", false, Identity("imdb_id", FieldType.Imdb, "imdb"), Identity("tvdb_id", FieldType.Id, "tvdb")),
            Fact("seasons", FieldType.List, nullable: false, rows: TmdbSeasonRow, unique: new[] { "season_number" }),
        }, new[] { "imdb", "tvdb" });

        /// <summary>
        /// A TMDB season: its episode list (an episode row JE can't read makes it Malformed), each episode of the season (and
        /// show) asked for and listed once (review round 9: membership and uniqueness); its own season number is the request's.
        /// </summary>
        public static readonly ResourceSchema TmdbSeason = new("tmdb season", new[]
        {
            Required("episodes", FieldType.List, TmdbEpisodeRow, unique: new[] { "episode_number" }), Display("season_number", FieldType.Count, RequestFact.Season),
        });

        /// <summary>
        /// TMDB's <c>find</c> for an IMDb EPISODE id: its episode results (a row JE can't read beside a usable one: Partial).
        /// One IMDb episode id names one episode (review round 9: two rows are ambiguous, Malformed).
        /// </summary>
        public static readonly ResourceSchema TmdbEpisodeFind = new("tmdb episode find", new[] { Required("tv_episode_results", FieldType.List, TmdbEpisodeFindRow, RowFailure.Partial, unique: Array.Empty<string>()) });

        /// <summary>TMDB's <c>find</c> for a title's IMDb or TVDB id: both result lists (rows read by the lookup).</summary>
        public static readonly ResourceSchema TmdbFind = new("tmdb find", new[] { Required("movie_results", FieldType.List), Required("tv_results", FieldType.List) });

        /// <summary>A TMDB search answer: its result list (rows read by the lookup) and its paging fields (review round 9: domain rules).</summary>
        public static readonly ResourceSchema TmdbSearch = new("tmdb search", new[]
        {
            Required("results", FieldType.List), Display("page", FieldType.Count), Display("total_pages", FieldType.Count), Display("total_results", FieldType.Count),
        }, Paging: new PagingRule("page", "total_pages", "total_results", "results"));

        /// <summary>Seerr's movie row (camelCase).</summary>
        public static readonly ResourceSchema SeerrMovieRow = TmdbMovieRow.Camel("seerr movie row");

        /// <summary>Seerr's show row.</summary>
        public static readonly ResourceSchema SeerrTvRow = TmdbTvRow.Camel("seerr tv row");

        /// <summary>Seerr's movie details (<c>imdbId</c> or <c>externalIds.imdbId</c>).</summary>
        public static readonly ResourceSchema SeerrMovieDetails = TmdbMovieDetails.Camel("seerr movie details");

        /// <summary>Seerr's TV details.</summary>
        public static readonly ResourceSchema SeerrTvDetails = TmdbTvDetails.Camel("seerr tv details");

        /// <summary>Seerr's season.</summary>
        public static readonly ResourceSchema SeerrSeason = TmdbSeason.Camel("seerr season");

        /// <summary>Seerr's search answer.</summary>
        public static readonly ResourceSchema SeerrSearch = TmdbSearch.Camel("seerr search");

        // ── Placeholder metadata (Seerr's names; JE mode reads TMDB's answer camelized first) ──

        /// <summary>
        /// A movie's placeholder metadata: its release date and poster are facts the entry is set from (a missing one is
        /// unknown: never cleared from it), its IMDb id an identity.
        /// </summary>
        public static readonly ResourceSchema MetadataMovie = new("metadata movie", new[]
        {
            Required("id", FieldType.Id, echo: RequestFact.Id), Display("title", FieldType.Text), Fact("releaseDate", FieldType.Date), Fact("posterPath", FieldType.Poster),
            Display("overview", FieldType.Text), Identity("imdbId", FieldType.Imdb, "imdb"),
            Container("externalIds", false, Identity("imdbId", FieldType.Imdb, "imdb")),
        }, new[] { "imdb" });

        private static readonly ResourceSchema MetadataEpisodeRef = new("metadata episode", new[]
        {
            Required("seasonNumber", FieldType.Count), Required("episodeNumber", FieldType.Count), Fact("airDate", FieldType.Date),
        });

        /// <summary>
        /// A show's placeholder metadata: first air date, poster, status (an ended show retires its entries), the season
        /// list with each season's episode count and air date (the expected episodes), the last and next aired episodes
        /// (Seerr leaves them out when there are none, so a missing one is none), and its IMDb and TVDB ids.
        /// </summary>
        public static readonly ResourceSchema MetadataShow = new("metadata show", new[]
        {
            Required("id", FieldType.Id, echo: RequestFact.Id), Display("name", FieldType.Text), Fact("firstAirDate", FieldType.Date), Fact("posterPath", FieldType.Poster),
            Display("overview", FieldType.Text), Fact("status", FieldType.Text), Display("inProduction", FieldType.Bool),
            Container("externalIds", false, Identity("imdbId", FieldType.Imdb, "imdb"), Identity("tvdbId", FieldType.Id, "tvdb")),
            Fact("seasons", FieldType.List, nullable: false, rows: new ResourceSchema("metadata season row", new[]
            {
                Required("seasonNumber", FieldType.Count), Fact("episodeCount", FieldType.Count, nullable: false), Fact("airDate", FieldType.Date),
            }), unique: new[] { "seasonNumber" }),
            new FieldRule("lastEpisodeToAir", FieldType.Object, FieldRole.Container, true, MetadataEpisodeRef),
            new FieldRule("nextEpisodeToAir", FieldType.Object, FieldRole.Container, true, MetadataEpisodeRef),
        }, new[] { "imdb", "tvdb" });

        /// <summary>
        /// A season's placeholder metadata: its episodes (with their air dates), air date and poster. Review round 9 (4c2-R9-2):
        /// the season (and its episodes, and their show) is the one asked for, and each episode is listed once.
        /// </summary>
        public static readonly ResourceSchema MetadataSeason = new("metadata season", new[]
        {
            Required("episodes", FieldType.List, new ResourceSchema("metadata episode row", new[]
            {
                Required("episodeNumber", FieldType.Count), Display("seasonNumber", FieldType.Count, RequestFact.Season), Display("showId", FieldType.Id, RequestFact.Show),
                Display("name", FieldType.Text), Fact("airDate", FieldType.Date),
            }), unique: new[] { "episodeNumber" }),
            Display("seasonNumber", FieldType.Count, RequestFact.Season), Fact("airDate", FieldType.Date), Fact("posterPath", FieldType.Poster),
        });

        /// <summary>
        /// A TMDB poster read (a title's or a season's details): <c>poster_path</c> is the answer (null: no poster); the title's
        /// id or the season's number is the one asked for (review round 9).
        /// </summary>
        public static readonly ResourceSchema TmdbPoster = new("tmdb poster", new[]
        {
            Fact("poster_path", FieldType.Poster), Display("id", FieldType.Id, RequestFact.Id), Display("season_number", FieldType.Count, RequestFact.Season),
        });

        /// <summary>
        /// Validates <paramref name="element"/> against <paramref name="schema"/> and the request that produced it (review round
        /// 9, D53): every declared field by its type and role (rounds 7–8), then the request's facts (a field that echoes the
        /// id, media type, season, show or page asked for must equal it: Malformed), uniqueness (a list's row key listed twice,
        /// or a single-answer list with more than one row: Malformed) and the page's domain rules (<see cref="PagingRule"/>:
        /// Partial).
        /// </summary>
        /// <param name="schema">The schema.</param>
        /// <param name="request">What was asked for.</param>
        /// <param name="element">The answer.</param>
        /// <returns>The verdict and identity facts.</returns>
        public static ContractRead Validate(ResourceSchema schema, AnswerRequest request, JsonElement element)
        {
            var read = new ContractRead();
            if (element.ValueKind != JsonValueKind.Object)
            {
                read.Lower(ResponseVerdict.Malformed, schema.Name);
                return read;
            }

            ReadFields(schema, element, read, read, string.Empty, request);
            foreach (var fact in schema.Facts ?? Array.Empty<string>())
            {
                if (read.Fact(fact) == FactState.Unknown)
                {
                    read.Lower(ResponseVerdict.Partial, fact);
                }
            }

            if (schema.Paging is { } paging)
            {
                CheckPaging(paging, element, read, request);
            }

            return read;
        }

        // A page's domain rules (review round 9, 4c2-R9-5): non-negative counts (a negative one was already unusable: Partial),
        // the page asked for, a total of at least the page's rows, and a page count of at least 1 when there is a total.
        private static void CheckPaging(PagingRule paging, JsonElement element, ContractRead read, AnswerRequest request)
        {
            var page = read.Int(paging.Page);
            var pages = read.Int(paging.Pages);
            var total = read.Int(paging.Total);
            var rows = element.TryGetProperty(paging.Rows, out var list) && list.ValueKind == JsonValueKind.Array ? list.GetArrayLength() : 0;
            if (request.Page is int asked && page is int answered && answered != asked)
            {
                read.Lower(ResponseVerdict.Partial, paging.Page + " (not the page asked for)");
            }

            if ((total is int t && t < rows) || (total is > 0 && pages is 0))
            {
                read.Lower(ResponseVerdict.Partial, paging.Total + " (inconsistent with the rows)");
            }
        }

        /// <summary>The worse of two verdicts.</summary>
        /// <param name="a">One.</param>
        /// <param name="b">Other.</param>
        /// <returns>The worse.</returns>
        public static ResponseVerdict Worst(ResponseVerdict a, ResponseVerdict b) => a > b ? a : b;

        /// <summary>A snake_case name in camelCase (TMDB's names as Seerr spells them).</summary>
        /// <param name="name">Name.</param>
        /// <returns>The camelCase name.</returns>
        public static string CamelName(string name)
        {
            var parts = name.Split('_');
            return parts[0] + string.Concat(parts.Skip(1).Select(p => p.Length == 0 ? p : char.ToUpperInvariant(p[0]) + p[1..]));
        }

        // Each declared field: its verdict and identity facts go to `read` (the whole answer's), its typed value to `into` (the
        // object it belongs to: the answer, a container's members, a row).
        private static void ReadFields(ResourceSchema schema, JsonElement element, ContractRead read, ContractRead into, string prefix, AnswerRequest request)
        {
            foreach (var field in schema.Fields)
            {
                var path = prefix + field.Name;
                if (!element.TryGetProperty(field.Name, out var value))
                {
                    Missing(field, read, path);
                    continue;
                }

                if (value.ValueKind == JsonValueKind.Null)
                {
                    Null(field, read, path);
                    continue;
                }

                if (Empty(field.Type, value))
                {
                    Emptied(field, read, path);
                    continue;
                }

                switch (Parse(field.Type, value, out var parsed))
                {
                    case Parsed.WrongType:
                        read.Lower(field.Role == FieldRole.Display ? ResponseVerdict.Partial : ResponseVerdict.Malformed, path);
                        continue;
                    case Parsed.Unusable:
                        // Review round 8 (4c2-R8-1): a value its consumer can't use is no value. A fact or a display field is then
                        // unknown (Partial: used for the rest, never kept, never clears what an entry has); the resource's own
                        // fields and an identity id that isn't one make the answer Malformed.
                        read.Lower(field.Role is FieldRole.Fact or FieldRole.Display ? ResponseVerdict.Partial : ResponseVerdict.Malformed, path);
                        continue;
                }

                // Review round 9 (4c2-R9-1/2): a field that echoes a request fact must be the one asked for; another id, media
                // type, season or show is another resource's answer.
                if (field.Echo != RequestFact.None && request.Of(field.Echo) is { } asked && !Echoes(asked, parsed))
                {
                    read.Lower(ResponseVerdict.Malformed, path + " (not the one asked for)");
                    continue;
                }

                if (field.Fact != null)
                {
                    read.Note(field.Fact, FactState.Known);
                }

                if (field.Type == FieldType.Object)
                {
                    var members = new ContractRead();
                    if (field.Members != null)
                    {
                        ReadFields(field.Members, value, read, members, path + ".", request);
                    }

                    into.Set(field.Name, FieldType.Object, members);
                }
                else if (field.Type == FieldType.List)
                {
                    into.Set(field.Name, FieldType.List, field.Members != null ? ReadRows(field, value, read, path, request) : Array.Empty<ContractRead>());
                }
                else
                {
                    into.Set(field.Name, field.Type, parsed!);
                }
            }
        }

        // A list's rows: a row JE can't read (not an object, a required field missing or bad) is what the list declares;
        // a row's unknown fact or unreadable display field makes the answer Partial. Returns the usable rows, in order.
        private static IReadOnlyList<ContractRead> ReadRows(FieldRule field, JsonElement list, ContractRead read, string path, AnswerRequest request)
        {
            var usable = new List<ContractRead>();
            var unreadable = 0;
            foreach (var row in list.EnumerateArray())
            {
                var rowRead = new ContractRead();
                if (row.ValueKind != JsonValueKind.Object)
                {
                    rowRead.Lower(ResponseVerdict.Malformed, path + "[]");
                }
                else
                {
                    ReadFields(field.Members!, row, rowRead, rowRead, path + "[].", request);
                }

                if (rowRead.Verdict == ResponseVerdict.Malformed)
                {
                    unreadable++;
                    if (field.Rows == RowFailure.Malformed)
                    {
                        read.Lower(ResponseVerdict.Malformed, rowRead.Reason ?? path);
                    }
                    else
                    {
                        read.Lower(ResponseVerdict.Partial, rowRead.Reason ?? path);
                    }

                    continue;
                }

                usable.Add(rowRead);
                read.Lower(rowRead.Verdict, rowRead.Reason ?? path);
            }

            if (usable.Count == 0 && unreadable > 0)
            {
                read.Lower(ResponseVerdict.Malformed, path);
            }

            // Review round 9 (uniqueness): a row key listed twice (an episode, a season) or, for a list of one answer, a
            // second row: the list doesn't say which one is meant.
            if (field.Unique is { } unique)
            {
                var keys = new HashSet<string>(StringComparer.Ordinal);
                if (unique.Count == 0 ? usable.Count > 1 : usable.Any(r => !keys.Add(string.Join('|', unique.Select(n => r.KeyOf(n) ?? "?")))))
                {
                    read.Lower(ResponseVerdict.Malformed, path + " (a row listed twice)");
                }
            }

            return usable;
        }

        // A typed value equals the request's fact (ids and numbers by value, text exactly).
        private static bool Echoes(object asked, object? parsed) => asked switch
        {
            int number => parsed is int value && value == number,
            string text => parsed is string value && string.Equals(value, text, StringComparison.Ordinal),
            _ => false,
        };

        private static void Missing(FieldRule field, ContractRead read, string path)
        {
            switch (field.Role)
            {
                case FieldRole.Required:
                    read.Lower(ResponseVerdict.Malformed, path);
                    break;
                case FieldRole.Fact:
                    read.Lower(ResponseVerdict.Partial, path); // unknown, never proof of an absence
                    break;
                case FieldRole.Container when field.Members != null:
                    // Members unknown: their identity facts stay unknown, their facts aren't read.
                    break;
            }
        }

        private static void Null(FieldRule field, ContractRead read, string path)
        {
            switch (field.Role)
            {
                case FieldRole.Required:
                    read.Lower(ResponseVerdict.Malformed, path);
                    break;
                case FieldRole.Identity:
                    read.Note(field.Fact!, FactState.Absent);
                    break;
                case FieldRole.Fact or FieldRole.Container when !field.Nullable:
                    read.Lower(ResponseVerdict.Malformed, path);
                    break;
            }
        }

        private static void Emptied(FieldRule field, ContractRead read, string path)
        {
            switch (field.Role)
            {
                case FieldRole.Required when field.Type != FieldType.List:
                    read.Lower(ResponseVerdict.Malformed, path);
                    break;
                case FieldRole.Identity:
                    read.Note(field.Fact!, FactState.Absent);
                    break;
            }
        }

        /// <summary>The date parser of every consumer: <c>yyyy-MM-dd</c>, or an ISO date-time read as its date; else null.</summary>
        /// <param name="value">Text.</param>
        /// <returns>The date as <c>yyyy-MM-dd</c>, or null.</returns>
        public static string? ParseDate(string? value)
        {
            var text = value?.Trim();
            if (text == null || text.Length < 10 || !ListRules.TryParseDate(text[..10], out _))
            {
                return null;
            }

            return text.Length == 10
                || (text[10] == 'T' && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out _))
                ? text[..10]
                : null;
        }

        /// <summary>The poster parser of every consumer: a TMDB image path (<c>/name.jpg</c> or <c>.png</c>); else null.</summary>
        /// <param name="value">Text.</param>
        /// <returns>The path, or null.</returns>
        public static string? ParsePoster(string? value)
        {
            var text = value?.Trim();
            return text != null && PosterRegex.IsMatch(text) ? text : null;
        }

        // "" for text, IMDb ids, dates and posters, 0 for an id: no value; an empty list or object is a value (read normally).
        private static bool Empty(FieldType type, JsonElement value) => type switch
        {
            FieldType.Text => value.ValueKind == JsonValueKind.String && ListRules.CleanText(value.GetString()).Trim().Length == 0,
            FieldType.Imdb or FieldType.Date or FieldType.Poster => value.ValueKind == JsonValueKind.String && value.GetString()!.Trim().Length == 0,
            FieldType.Id => value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var id) && id == 0,
            _ => false,
        };

        // The one parser per type (review round 8): the JSON type first (WrongType), then the value (Unusable).
        private static Parsed Parse(FieldType type, JsonElement value, out object? parsed)
        {
            parsed = null;
            switch (type)
            {
                case FieldType.Id or FieldType.Count:
                    if (value.ValueKind != JsonValueKind.Number)
                    {
                        return Parsed.WrongType;
                    }

                    if (!value.TryGetInt32(out var number) || (type == FieldType.Id ? number <= 0 : number < 0))
                    {
                        return Parsed.Unusable;
                    }

                    parsed = number;
                    return Parsed.Ok;
                case FieldType.Number:
                    if (value.ValueKind != JsonValueKind.Number)
                    {
                        return Parsed.WrongType;
                    }

                    parsed = value.GetDouble();
                    return Parsed.Ok;
                case FieldType.Bool:
                    if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    {
                        return Parsed.WrongType;
                    }

                    parsed = value.GetBoolean();
                    return Parsed.Ok;
                case FieldType.Object:
                    return value.ValueKind == JsonValueKind.Object ? Parsed.Ok : Parsed.WrongType;
                case FieldType.List:
                    return value.ValueKind == JsonValueKind.Array ? Parsed.Ok : Parsed.WrongType;
            }

            if (value.ValueKind != JsonValueKind.String)
            {
                return Parsed.WrongType;
            }

            var text = value.GetString()!;
            parsed = type switch
            {
                FieldType.Text => ListRules.CleanText(text).Trim(),
                FieldType.Imdb => ImdbRegex.IsMatch(text.Trim()) ? text.Trim() : null,
                FieldType.Date => ParseDate(text),
                FieldType.Poster => ParsePoster(text),
                _ => null,
            };
            return parsed == null ? Parsed.Unusable : Parsed.Ok;
        }
    }
}
