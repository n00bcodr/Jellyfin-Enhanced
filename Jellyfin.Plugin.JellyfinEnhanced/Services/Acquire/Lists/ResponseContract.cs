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
    /// <param name="Unique">Lists: the member names that key a row (two usable rows with the same key make the answer
    /// Malformed); an empty key means the list holds at most one row (more is ambiguous: Malformed).</param>
    internal sealed record FieldRule(string Name, FieldType Type, FieldRole Role, bool Nullable = true, ResourceSchema? Members = null, RowFailure Rows = RowFailure.Malformed, string? Fact = null,
        IReadOnlyList<string>? Unique = null);

    /// <summary>
    /// A typed fact of a request (review round 10, D53 "derived request bindings"): every contract declares, for EVERY fact,
    /// the answer field that must echo it or a named reason why none can (<see cref="FactBinding"/>).
    /// </summary>
    internal enum RequestFact
    {
        /// <summary>The resource kind asked for: the contract's own name (one contract per route).</summary>
        Kind,

        /// <summary>The TMDB id asked for (details, a <c>tmdb:N</c> title, a collection, an MDBList title).</summary>
        Id,

        /// <summary>The media type asked for (<c>movie</c> or <c>tv</c>; MDBList's <c>movie</c> or <c>show</c>).</summary>
        MediaType,

        /// <summary>The season asked for.</summary>
        Season,

        /// <summary>The show a season was asked of.</summary>
        Show,

        /// <summary>The page asked for.</summary>
        Page,

        /// <summary>The list asked for (a TMDB list id, an IMDb <c>ls</c> id).</summary>
        ListId,

        /// <summary>The Chronolists universe asked for (its address, e.g. <c>mcu</c>).</summary>
        Universe,

        /// <summary>The TMDB id of an explicit-id search (<c>tmdb:N</c>).</summary>
        SearchTmdbId,

        /// <summary>The external id of an explicit-id search or find (<c>imdb:tt…</c>, <c>tvdb:N</c>).</summary>
        SearchExternalId,

        /// <summary>The set of TMDB ids a batch asked for.</summary>
        IdSet,
    }

    /// <summary>
    /// What an answer was asked for (review rounds 9 and 10, D53): the request's typed facts. A fact the request names is checked
    /// by the contract's binding of it (<see cref="FactBinding"/>); a fact it doesn't name isn't asked about.
    /// </summary>
    /// <param name="Id">The TMDB id asked for.</param>
    /// <param name="MediaType">"movie" or "tv" (MDBList: "movie" or "show").</param>
    /// <param name="Season">The season number asked for.</param>
    /// <param name="Show">The show's TMDB id a season was asked of.</param>
    /// <param name="Page">The page asked for.</param>
    internal sealed record AnswerRequest(int? Id = null, string? MediaType = null, int? Season = null, int? Show = null, int? Page = null)
    {
        /// <summary>A request that names nothing (a row read on its own).</summary>
        public static readonly AnswerRequest None = new();

        /// <summary>The resource kind asked for (the contract's name), or null.</summary>
        public string? Kind { get; init; }

        /// <summary>The list asked for, or null.</summary>
        public string? ListId { get; init; }

        /// <summary>The Chronolists universe asked for, or null.</summary>
        public string? Universe { get; init; }

        /// <summary>The TMDB id of an explicit-id search, or null.</summary>
        public int? SearchTmdbId { get; init; }

        /// <summary>The external id of an explicit-id search or find, or null.</summary>
        public string? SearchExternalId { get; init; }

        /// <summary>The TMDB ids a batch asked for, or null.</summary>
        public IReadOnlyCollection<int>? Ids { get; init; }

        /// <summary>The value of a request fact, or null when the request doesn't name it.</summary>
        /// <param name="fact">The fact.</param>
        /// <returns>The value.</returns>
        public object? Of(RequestFact fact) => fact switch
        {
            RequestFact.Kind => Kind,
            RequestFact.Id => Id,
            RequestFact.MediaType => MediaType,
            RequestFact.Season => Season,
            RequestFact.Show => Show,
            RequestFact.Page => Page,
            RequestFact.ListId => ListId,
            RequestFact.Universe => Universe,
            RequestFact.SearchTmdbId => SearchTmdbId,
            RequestFact.SearchExternalId => SearchExternalId,
            RequestFact.IdSet => Ids,
            _ => null,
        };
    }

    /// <summary>How a contract binds one request fact (review round 10).</summary>
    internal enum BindingKind
    {
        /// <summary>
        /// Answer fields echo it: each REQUIRED path must be there with the value asked for (missing: the answer is UNBOUND,
        /// never definitive, never kept, never clearing); every optional path that is there must agree. Another value is an
        /// answer to another request.
        /// </summary>
        Echo,

        /// <summary>The contract IS the fact (one contract per route): a request naming another kind is refused (Malformed).</summary>
        Route,

        /// <summary>No answer field can echo it (the reason says why); the fact is never checked.</summary>
        NotApplicable,
    }

    /// <summary>One answer path a binding reads: <c>a.b</c> walks objects, <c>rows[].x</c> is every row of the list.</summary>
    /// <param name="Path">The path (provider names; Seerr's are camelCase).</param>
    /// <param name="Required">The answer must carry it (for a row path: every row there is).</param>
    internal sealed record EchoPath(string Path, bool Required);

    /// <summary>A contract's binding of one request fact (review round 10, D53 "derived request bindings").</summary>
    /// <param name="Kind">How it is bound.</param>
    /// <param name="Paths">The answer paths that echo it (<see cref="BindingKind.Echo"/>).</param>
    /// <param name="Reason">Why it is bound without a required echo (optional paths only, a route, or none at all).</param>
    /// <param name="OnMismatch">What another value makes the answer: Malformed (another resource's answer), or Partial for a
    /// page (rows of the same list or search, but not the page asked for: used, never kept).</param>
    internal sealed record FactBinding(BindingKind Kind, IReadOnlyList<EchoPath> Paths, string? Reason, ResponseVerdict OnMismatch = ResponseVerdict.Malformed)
    {
        /// <summary>Required echo paths.</summary>
        /// <param name="paths">Paths.</param>
        /// <returns>The binding.</returns>
        public static FactBinding Echo(params string[] paths) => new(BindingKind.Echo, paths.Select(p => new EchoPath(p, true)).ToList(), null);

        /// <summary>One required echo path, and optional ones that must agree when they are there.</summary>
        /// <param name="required">The required path.</param>
        /// <param name="optional">Optional paths.</param>
        /// <returns>The binding.</returns>
        public static FactBinding EchoAnd(string required, params string[] optional) =>
            new(BindingKind.Echo, new[] { new EchoPath(required, true) }.Concat(optional.Select(p => new EchoPath(p, false))).ToList(), null);

        /// <summary>Optional echo paths only: the reason says what binds the fact when none is there.</summary>
        /// <param name="reason">Reason.</param>
        /// <param name="paths">Paths.</param>
        /// <returns>The binding.</returns>
        public static FactBinding WhenPresent(string reason, params string[] paths) => new(BindingKind.Echo, paths.Select(p => new EchoPath(p, false)).ToList(), reason);

        /// <summary>The contract is the fact.</summary>
        /// <param name="reason">Reason.</param>
        /// <returns>The binding.</returns>
        public static FactBinding Route(string reason) => new(BindingKind.Route, Array.Empty<EchoPath>(), reason);

        /// <summary>No answer field can echo it.</summary>
        /// <param name="reason">Reason.</param>
        /// <returns>The binding.</returns>
        public static FactBinding NotApplicable(string reason) => new(BindingKind.NotApplicable, Array.Empty<EchoPath>(), reason);

        /// <summary>The same binding; another value makes the answer Partial (a page of the same list or search).</summary>
        /// <returns>The binding.</returns>
        public FactBinding PartialOnMismatch() => this with { OnMismatch = ResponseVerdict.Partial };

        /// <summary>The same binding in Seerr's names (camelCase).</summary>
        /// <returns>The binding.</returns>
        public FactBinding Camel() => this with { Paths = Paths.Select(p => p with { Path = string.Join('.', p.Path.Split('.').Select(ResponseContract.CamelName)) }).ToList() };
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
    /// <param name="Bindings">The binding of every request fact (review round 10): every contract of <see cref="ResponseContract.All"/> declares all of them.</param>
    internal sealed record ResourceSchema(string Name, IReadOnlyList<FieldRule> Fields, IReadOnlyList<string>? Facts = null, PagingRule? Paging = null,
        IReadOnlyDictionary<RequestFact, FactBinding>? Bindings = null)
    {
        /// <summary>The same schema in Seerr's names (camelCase), e.g. <c>external_ids.imdb_id</c> → <c>externalIds.imdbId</c>.</summary>
        /// <param name="name">The camelCase schema's name.</param>
        /// <returns>The schema.</returns>
        public ResourceSchema Camel(string name) => new(
            name,
            Fields.Select(f => f with { Name = ResponseContract.CamelName(f.Name), Members = f.Members?.Camel(f.Members.Name), Unique = f.Unique?.Select(ResponseContract.CamelName).ToList() }).ToList(),
            Facts,
            Paging == null ? null : new PagingRule(ResponseContract.CamelName(Paging.Page), ResponseContract.CamelName(Paging.Pages), ResponseContract.CamelName(Paging.Total), ResponseContract.CamelName(Paging.Rows)),
            Bindings?.ToDictionary(b => b.Key, b => b.Value.Camel()));

        /// <summary>This schema with more fields (another resource built on it).</summary>
        /// <param name="name">The new schema's name.</param>
        /// <param name="fields">Fields added.</param>
        /// <param name="facts">Identity facts.</param>
        /// <param name="bindings">Bindings that differ from this schema's.</param>
        /// <returns>The schema.</returns>
        public ResourceSchema With(string name, IEnumerable<FieldRule> fields, IReadOnlyList<string>? facts = null, IReadOnlyDictionary<RequestFact, FactBinding>? bindings = null)
        {
            var merged = new Dictionary<RequestFact, FactBinding>(Bindings ?? new Dictionary<RequestFact, FactBinding>());
            foreach (var binding in bindings ?? new Dictionary<RequestFact, FactBinding>())
            {
                merged[binding.Key] = binding.Value;
            }

            return new(name, Fields.Concat(fields).ToList(), facts ?? Facts, Paging, merged);
        }

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

        /// <summary>Why the verdict isn't Valid, or null: a fixed code and DECLARED field paths only (review round 10, 4c2-R10-6), never a provider's value or member name.</summary>
        public string? Reason { get; private set; }

        /// <summary>
        /// A request fact the request named had no echo where the contract requires one (review round 10): the answer may be
        /// another request's, so it is never definitive (Partial: never kept, never proof of an absence, never clearing).
        /// </summary>
        public bool Unbound { get; private set; }

        /// <summary>Marks the answer unbound (the binder only).</summary>
        /// <param name="reason">The fixed code and declared path.</param>
        public void Unbind(string reason)
        {
            Unbound = true;
            Lower(ResponseVerdict.Partial, reason);
        }

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

        private static FieldRule Required(string name, FieldType type, ResourceSchema? rows = null, RowFailure failure = RowFailure.Malformed, string[]? unique = null) =>
            new(name, type, FieldRole.Required, false, rows, failure, Unique: unique);

        private static FieldRule Display(string name, FieldType type) => new(name, type, FieldRole.Display);

        private static FieldRule Fact(string name, FieldType type, bool nullable = true, ResourceSchema? rows = null, string[]? unique = null) => new(name, type, FieldRole.Fact, nullable, rows, Unique: unique);

        private static FieldRule Identity(string name, FieldType type, string fact) => new(name, type, FieldRole.Identity, true, Fact: fact);

        private static FieldRule Container(string name, bool nullable, params FieldRule[] members) => new(name, FieldType.Object, FieldRole.Container, nullable, new ResourceSchema(name, members));

        // ── Request bindings (review round 10, D53 "derived request bindings"): EVERY contract binds EVERY request fact, by
        // position (Bound), so a fact can't be left out; ContractBindingsTests enumerates every (contract × fact) pair. ──

        private const string MediaByRoute = "TMDB's and Seerr's details carry no media type: the route (movie/ or tv/) binds it, with the type's required name field (title, name); a declared media_type must agree";

        private const string MediaOfMetadata = "Seerr's and TMDB's details carry no top-level media type: the route (movie/ or tv/) binds it; a declared mediaType, or Seerr's mediaInfo.mediaType when Seerr has the title, must agree";

        private const string SeasonOwnId = "a season's own id is the season's TMDB id (Breaking Bad S1: 3572), never a title's: the season and its show bind the answer";

        private const string CursorPages = "cursor pages: no page number (the cursor and total rules of review round 3 apply)";

        private static readonly FactBinding KindRoute = FactBinding.Route("one contract per route: a request names the kind it was sent for, and an answer read by another kind's contract is refused");

        private static readonly FactBinding NoId = FactBinding.NotApplicable("not a title read: no TMDB title id is asked for");

        private static readonly FactBinding NoMedia = FactBinding.NotApplicable("not a title read: no media type is asked for (rows declare their own)");

        private static readonly FactBinding NoSeason = FactBinding.NotApplicable("not a season read: no season is asked for");

        private static readonly FactBinding NoShow = FactBinding.NotApplicable("not a season read: no show is asked for");

        private static readonly FactBinding NoPage = FactBinding.NotApplicable("one answer, not a page");

        private static readonly FactBinding NoList = FactBinding.NotApplicable("not a list read: no list is asked for");

        private static readonly FactBinding NoUniverse = FactBinding.NotApplicable("not a Chronolists read");

        private static readonly FactBinding NoSearch = FactBinding.NotApplicable("not an explicit-id search");

        private static readonly FactBinding NoExternal = FactBinding.NotApplicable("not keyed by an external (IMDb, TVDB) id");

        private static readonly FactBinding NoIdSet = FactBinding.NotApplicable("one resource per request, not a batch");

        // The bindings of a contract, one per request fact, by position: none can be left out.
        private static Dictionary<RequestFact, FactBinding> Bound(
            FactBinding kind, FactBinding id, FactBinding mediaType, FactBinding season, FactBinding show, FactBinding page, FactBinding listId,
            FactBinding universe, FactBinding searchTmdbId, FactBinding searchExternalId, FactBinding idSet) => new()
        {
            [RequestFact.Kind] = kind,
            [RequestFact.Id] = id,
            [RequestFact.MediaType] = mediaType,
            [RequestFact.Season] = season,
            [RequestFact.Show] = show,
            [RequestFact.Page] = page,
            [RequestFact.ListId] = listId,
            [RequestFact.Universe] = universe,
            [RequestFact.SearchTmdbId] = searchTmdbId,
            [RequestFact.SearchExternalId] = searchExternalId,
            [RequestFact.IdSet] = idSet,
        };

        // A title row or details (movie or show): the id asked for; a declared media type agrees.
        private static Dictionary<RequestFact, FactBinding> TitleBindings() =>
            Bound(KindRoute, FactBinding.Echo("id"), FactBinding.WhenPresent(MediaByRoute, "media_type"), NoSeason, NoShow, NoPage, NoList, NoUniverse, NoSearch, NoExternal, NoIdSet);

        // A season (import lookups, posters' TMDB names): its own number, every episode's show.
        private static Dictionary<RequestFact, FactBinding> SeasonBindings(FactBinding id) =>
            Bound(KindRoute, id, FactBinding.NotApplicable("a season is always a show's"), FactBinding.EchoAnd("season_number", "episodes[].season_number"),
                FactBinding.Echo("episodes[].show_id"), NoPage, NoList, NoUniverse, NoSearch, NoExternal, NoIdSet);

        // Placeholder metadata of a title (Seerr's names).
        private static Dictionary<RequestFact, FactBinding> MetadataTitleBindings() =>
            Bound(KindRoute, FactBinding.Echo("id"), FactBinding.WhenPresent(MediaOfMetadata, "mediaType", "mediaInfo.mediaType"), NoSeason, NoShow, NoPage, NoList, NoUniverse, NoSearch, NoExternal, NoIdSet);

        // A chart page (TMDB's trending and charts; Seerr's camelCase of them).
        private static Dictionary<RequestFact, FactBinding> ChartPageBindings() =>
            Bound(KindRoute, NoId, NoMedia, NoSeason, NoShow, FactBinding.Echo("page").PartialOnMismatch(),
                FactBinding.NotApplicable("a chart is named by its route (trending/movie/week, movie/top_rated, discover/…/upcoming): its answer names no chart"), NoUniverse, NoSearch, NoExternal, NoIdSet);

        // ── Import lookups (TMDB's names; Seerr's are the camelCase of the same) ──

        /// <summary>A movie row of a search or find answer (also the title part of movie details).</summary>
        public static readonly ResourceSchema TmdbMovieRow = new("tmdb movie row", new[]
        {
            Required("id", FieldType.Id), Display("media_type", FieldType.Text), Required("title", FieldType.Text), Display("original_title", FieldType.Text),
            Display("release_date", FieldType.Date), Display("poster_path", FieldType.Poster), Display("overview", FieldType.Text),
            Display("popularity", FieldType.Number), Display("vote_count", FieldType.Count), Display("adult", FieldType.Bool),
        }, Bindings: TitleBindings());

        /// <summary>A show row of a search or find answer (also the title part of TV details).</summary>
        public static readonly ResourceSchema TmdbTvRow = new("tmdb tv row", new[]
        {
            Required("id", FieldType.Id), Display("media_type", FieldType.Text), Required("name", FieldType.Text), Display("original_name", FieldType.Text),
            Display("first_air_date", FieldType.Date), Display("poster_path", FieldType.Poster), Display("overview", FieldType.Text),
            Display("popularity", FieldType.Number), Display("vote_count", FieldType.Count), Display("adult", FieldType.Bool),
        }, Bindings: TitleBindings());

        private static readonly ResourceSchema TmdbSeasonRow = new("tmdb season row", new[]
        {
            Required("season_number", FieldType.Count), Display("episode_count", FieldType.Count), Display("air_date", FieldType.Date), Display("name", FieldType.Text),
        });

        // An episode of the season asked for (review round 9, 4c2-R9-2: membership): its own season and show, where it names
        // them, are the request's.
        private static readonly ResourceSchema TmdbEpisodeRow = new("tmdb episode row", new[]
        {
            Required("episode_number", FieldType.Count), Display("season_number", FieldType.Count), Display("show_id", FieldType.Id),
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
        /// A TMDB season: its episode list (an episode row JE can't read makes it Malformed), each episode listed once (review
        /// round 9). Review round 10 (bindings): its own <c>season_number</c> is the season asked for and every episode's
        /// <c>show_id</c> the show asked for (both required: TMDB's and Seerr's real seasons carry them); an episode's own
        /// season number, when there, agrees.
        /// </summary>
        public static readonly ResourceSchema TmdbSeason = new("tmdb season", new[]
        {
            Required("episodes", FieldType.List, TmdbEpisodeRow, unique: new[] { "episode_number" }), Display("season_number", FieldType.Count),
        }, Bindings: SeasonBindings(FactBinding.NotApplicable(SeasonOwnId)));

        /// <summary>
        /// TMDB's <c>find</c> for an IMDb EPISODE id: its episode results (a row JE can't read beside a usable one: Partial).
        /// One IMDb episode id names one episode (review round 9: two rows are ambiguous, Malformed).
        /// </summary>
        public static readonly ResourceSchema TmdbEpisodeFind = new("tmdb episode find", new[] { Required("tv_episode_results", FieldType.List, TmdbEpisodeFindRow, RowFailure.Partial, unique: Array.Empty<string>()) },
            Bindings: Bound(KindRoute, NoId, NoMedia, FactBinding.NotApplicable("found, not asked: the IMDb episode id names the episode"), FactBinding.NotApplicable("found, not asked: the IMDb episode id names the show"),
                NoPage, NoList, NoUniverse, NoSearch, FactBinding.NotApplicable("TMDB's find is keyed by the IMDb episode id and its episode rows carry none: one episode per id (a second row is ambiguous)"), NoIdSet));

        /// <summary>TMDB's <c>find</c> for a title's IMDb or TVDB id: both result lists (rows read by the lookup).</summary>
        public static readonly ResourceSchema TmdbFind = new("tmdb find", new[] { Required("movie_results", FieldType.List), Required("tv_results", FieldType.List) },
            Bindings: Bound(KindRoute, NoId, FactBinding.NotApplicable("each result list is of one type (movie_results, tv_results): its rows are typed by the list"), NoSeason, NoShow, NoPage, NoList, NoUniverse, NoSearch,
                FactBinding.NotApplicable("TMDB's find is keyed by the IMDb or TVDB id and its rows carry neither"), NoIdSet));

        /// <summary>A TMDB search answer: its result list (rows read by the lookup) and its paging fields (review round 9: domain rules).</summary>
        public static readonly ResourceSchema TmdbSearch = new("tmdb search", new[]
        {
            Required("results", FieldType.List), Display("page", FieldType.Count), Display("total_pages", FieldType.Count), Display("total_results", FieldType.Count),
        }, Paging: new PagingRule("page", "total_pages", "total_results", "results"),
            Bindings: Bound(KindRoute, NoId, FactBinding.NotApplicable("a search mixes types: each row declares its own and is read by the row contracts"), NoSeason, NoShow,
                FactBinding.Echo("page").PartialOnMismatch(), NoList, NoUniverse, FactBinding.Echo("results[].id"),
                FactBinding.NotApplicable("search rows carry no external id: an imdb:/tvdb: search is answered with the titles TMDB's find names for it"), NoIdSet));

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
            Required("id", FieldType.Id), Display("title", FieldType.Text), Fact("releaseDate", FieldType.Date), Fact("posterPath", FieldType.Poster),
            Display("overview", FieldType.Text), Identity("imdbId", FieldType.Imdb, "imdb"),
            Container("externalIds", false, Identity("imdbId", FieldType.Imdb, "imdb")),
        }, new[] { "imdb" }, Bindings: MetadataTitleBindings());

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
            Required("id", FieldType.Id), Display("name", FieldType.Text), Fact("firstAirDate", FieldType.Date), Fact("posterPath", FieldType.Poster),
            Display("overview", FieldType.Text), Fact("status", FieldType.Text), Display("inProduction", FieldType.Bool), Display("numberOfSeasons", FieldType.Count),
            Container("externalIds", false, Identity("imdbId", FieldType.Imdb, "imdb"), Identity("tvdbId", FieldType.Id, "tvdb")),
            Fact("seasons", FieldType.List, nullable: false, rows: new ResourceSchema("metadata season row", new[]
            {
                Required("seasonNumber", FieldType.Count), Fact("episodeCount", FieldType.Count, nullable: false), Fact("airDate", FieldType.Date),
            }), unique: new[] { "seasonNumber" }),
            new FieldRule("lastEpisodeToAir", FieldType.Object, FieldRole.Container, true, MetadataEpisodeRef),
            new FieldRule("nextEpisodeToAir", FieldType.Object, FieldRole.Container, true, MetadataEpisodeRef),
        }, new[] { "imdb", "tvdb" }, Bindings: MetadataTitleBindings());

        /// <summary>
        /// A season's placeholder metadata: its episodes (with their air dates), air date and poster. Review round 9 (4c2-R9-2):
        /// the season (and its episodes, and their show) is the one asked for, and each episode is listed once.
        /// </summary>
        public static readonly ResourceSchema MetadataSeason = new("metadata season", new[]
        {
            Required("episodes", FieldType.List, new ResourceSchema("metadata episode row", new[]
            {
                Required("episodeNumber", FieldType.Count), Display("seasonNumber", FieldType.Count), Display("showId", FieldType.Id),
                Display("name", FieldType.Text), Fact("airDate", FieldType.Date),
            }), unique: new[] { "episodeNumber" }),
            Display("seasonNumber", FieldType.Count), Fact("airDate", FieldType.Date), Fact("posterPath", FieldType.Poster),
        }, Bindings: SeasonBindings(FactBinding.NotApplicable(SeasonOwnId)).ToDictionary(b => b.Key, b => b.Value.Camel()));

        /// <summary>
        /// A TMDB poster read (a title's or a season's details): <c>poster_path</c> is the answer (null: no poster); the title's
        /// id or the season's number is the one asked for (review round 9).
        /// </summary>
        public static readonly ResourceSchema TmdbPoster = new("tmdb poster", new[]
        {
            Fact("poster_path", FieldType.Poster), Display("id", FieldType.Id), Display("season_number", FieldType.Count),
        }, Bindings: Bound(KindRoute, FactBinding.Echo("id"), FactBinding.NotApplicable("the route (movie/, tv/) binds it; TMDB's details carry no media type"),
            FactBinding.Echo("season_number"), FactBinding.Echo("episodes[].show_id"), NoPage, NoList, NoUniverse, NoSearch, NoExternal, NoIdSet));

        // ── List sources and MDBList records (review round 10): their rows are read by the source fetcher's row readers and
        // MdblistService.CheckRecord; these contracts bind each answer to its request (one binder for every contract). ──

        /// <summary>A TMDB list page (<c>list/{id}?page=N</c>): its <c>id</c> is the list asked for and its <c>page</c> the page.</summary>
        public static readonly ResourceSchema TmdbListPage = new("tmdb list page", Array.Empty<FieldRule>(), Bindings: Bound(KindRoute,
            FactBinding.NotApplicable("a list is asked for by its list id (ListId), not a title id"), NoMedia, NoSeason, NoShow, FactBinding.Echo("page").PartialOnMismatch(),
            FactBinding.Echo("id"), NoUniverse, NoSearch, NoExternal, NoIdSet));

        /// <summary>A TMDB chart or trending page: its <c>page</c> is the page asked for.</summary>
        public static readonly ResourceSchema TmdbChartPage = new("tmdb chart page", Array.Empty<FieldRule>(), Bindings: ChartPageBindings());

        /// <summary>A TMDB collection (<c>collection/{id}</c>): its <c>id</c> is the collection asked for.</summary>
        public static readonly ResourceSchema TmdbCollection = new("tmdb collection", Array.Empty<FieldRule>(), Bindings: Bound(KindRoute, FactBinding.Echo("id"),
            FactBinding.NotApplicable("a collection's parts are movies"), NoSeason, NoShow, NoPage, FactBinding.NotApplicable("a collection is asked for by its TMDB id (Id)"), NoUniverse, NoSearch, NoExternal, NoIdSet));

        /// <summary>Seerr's collection (<c>/api/v1/collection/{id}</c>).</summary>
        public static readonly ResourceSchema SeerrCollection = TmdbCollection.Camel("seerr collection");

        /// <summary>Seerr's trending and upcoming pages.</summary>
        public static readonly ResourceSchema SeerrChartPage = TmdbChartPage.Camel("seerr chart page");

        /// <summary>
        /// A Trakt page, as its pagination headers say (<c>X-Pagination-Page</c> read as <c>page</c>; Trakt's body is a bare
        /// array of rows).
        /// </summary>
        public static readonly ResourceSchema TraktPage = new("trakt page", Array.Empty<FieldRule>(), Bindings: Bound(KindRoute, NoId, NoMedia, NoSeason, NoShow,
            FactBinding.Echo("page").PartialOnMismatch(),
            FactBinding.NotApplicable("Trakt's list-items answer is a bare array of rows without a list field: the route (users/<user>/lists/<list>, lists/<id>) binds it"),
            NoUniverse, NoSearch, NoExternal, NoIdSet));

        /// <summary>An IMDb list page (GraphQL <c>data</c>): <c>list.id</c> is the list asked for.</summary>
        public static readonly ResourceSchema ImdbListPage = new("imdb list page", Array.Empty<FieldRule>(), Bindings: Bound(KindRoute, NoId, NoMedia, NoSeason, NoShow,
            FactBinding.NotApplicable(CursorPages), FactBinding.Echo("list.id"), NoUniverse, NoSearch, NoExternal, NoIdSet));

        /// <summary>An IMDb watchlist page (GraphQL <c>data</c>).</summary>
        public static readonly ResourceSchema ImdbWatchlistPage = new("imdb watchlist page", Array.Empty<FieldRule>(), Bindings: Bound(KindRoute, NoId, NoMedia, NoSeason, NoShow,
            FactBinding.NotApplicable(CursorPages),
            FactBinding.NotApplicable("IMDb's predefinedList is keyed by its userId argument and names no user in its answer (a p. profile is first resolved to that userId)"),
            NoUniverse, NoSearch, NoExternal, NoIdSet));

        /// <summary>An IMDb chart page (GraphQL <c>data</c>).</summary>
        public static readonly ResourceSchema ImdbChartPage = new("imdb chart page", Array.Empty<FieldRule>(), Bindings: Bound(KindRoute, NoId, NoMedia, NoSeason, NoShow,
            FactBinding.NotApplicable(CursorPages), FactBinding.NotApplicable("chartTitles is keyed by its chartType argument and names no chart in its answer"),
            NoUniverse, NoSearch, NoExternal, NoIdSet));

        /// <summary>An MDBList list answer (the public JSON or the API's items).</summary>
        public static readonly ResourceSchema MdblistList = new("mdblist list", Array.Empty<FieldRule>(), Bindings: Bound(KindRoute, NoId, NoMedia, NoSeason, NoShow,
            FactBinding.NotApplicable("one answer (the API's next page is never followed: more only means incomplete)"),
            FactBinding.NotApplicable("MDBList's list answer is the list's rows only (public JSON and API items), without a list field: the route binds it"),
            NoUniverse, NoSearch, NoExternal, NoIdSet));

        /// <summary>
        /// A Chronolists watch-order page (its <c>__NEXT_DATA__</c> JSON): <c>props.pageProps.universe.id</c> is the universe asked
        /// for (the address's), and Next's <c>query.universe</c>, when there, agrees.
        /// </summary>
        public static readonly ResourceSchema ChronolistsUniverse = new("chronolists universe", Array.Empty<FieldRule>(), Bindings: Bound(KindRoute, NoId,
            FactBinding.NotApplicable("entries declare their own type (tv, movie)"), NoSeason, NoShow, FactBinding.NotApplicable("one page"),
            FactBinding.NotApplicable("Chronolists names its watch order by its universe (Universe)"),
            FactBinding.EchoAnd("props.pageProps.universe.id", "query.universe"), NoSearch, NoExternal, NoIdSet));

        /// <summary>An MDBList title's record (<c>/tmdb/{type}/{id}</c>): <c>ids.tmdb</c> is the title and <c>type</c> the type asked for.</summary>
        public static readonly ResourceSchema MdblistRecord = new("mdblist record", Array.Empty<FieldRule>(), Bindings: Bound(KindRoute, FactBinding.Echo("ids.tmdb"),
            FactBinding.Echo("type"), NoSeason, NoShow, NoPage, NoList, NoUniverse, NoSearch, NoExternal, NoIdSet));

        /// <summary>One row of an MDBList media batch: <c>ids.tmdb</c> is one of the ids asked for (each once: the batch's own rule) and <c>type</c> the type asked for.</summary>
        public static readonly ResourceSchema MdblistBatchRow = new("mdblist batch row", Array.Empty<FieldRule>(), Bindings: Bound(KindRoute,
            FactBinding.NotApplicable("a batch asks for a set of ids (IdSet), each row one of them"), FactBinding.Echo("type"), NoSeason, NoShow, NoPage, NoList, NoUniverse, NoSearch, NoExternal,
            FactBinding.Echo("ids.tmdb")));

        /// <summary>
        /// Every contract of a provider answer the list subsystem reads (review round 10): each binds every request fact
        /// (ContractBindingsTests enumerates the pairs; a contract a reader validates against must be listed here).
        /// </summary>
        public static IReadOnlyList<ResourceSchema> All => new[]
        {
            TmdbMovieRow, TmdbTvRow, TmdbMovieDetails, TmdbTvDetails, TmdbSeason, TmdbEpisodeFind, TmdbFind, TmdbSearch,
            SeerrMovieRow, SeerrTvRow, SeerrMovieDetails, SeerrTvDetails, SeerrSeason, SeerrSearch,
            MetadataMovie, MetadataShow, MetadataSeason, TmdbPoster,
            TmdbListPage, TmdbChartPage, TmdbCollection, SeerrCollection, SeerrChartPage, TraktPage, ImdbListPage, ImdbWatchlistPage, ImdbChartPage, MdblistList, ChronolistsUniverse,
            MdblistRecord, MdblistBatchRow,
        };

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

            ReadFields(schema, element, read, read, string.Empty);
            foreach (var fact in schema.Facts ?? Array.Empty<string>())
            {
                if (read.Fact(fact) == FactState.Unknown)
                {
                    read.Lower(ResponseVerdict.Partial, fact);
                }
            }

            if (schema.Paging is { } paging)
            {
                CheckPaging(paging, element, read);
            }

            Bind(schema, request, element, read);
            return read;
        }

        // A page's domain rules (review round 9, 4c2-R9-5; the page asked for is the binder's, review round 10): non-negative
        // counts (a negative one was already unusable: Partial), a total of at least the page's rows, a page count of at least 1
        // when there is a total. Review round 10 (4c2-R10-5, occupancy): a page within the page count holds rows when the total
        // says there are some, and an empty page is "no titles" only when its total says 0 (missing: not affirmed).
        private static void CheckPaging(PagingRule paging, JsonElement element, ContractRead read)
        {
            var page = read.Int(paging.Page);
            var pages = read.Int(paging.Pages);
            var total = read.Int(paging.Total);
            var rows = element.TryGetProperty(paging.Rows, out var list) && list.ValueKind == JsonValueKind.Array ? list.GetArrayLength() : 0;
            if ((total is int t && t < rows) || (total is > 0 && pages is 0))
            {
                read.Lower(ResponseVerdict.Partial, "paging:" + paging.Total + " (inconsistent with the rows)");
            }

            if (rows == 0 && total is > 0 && !(page is int p && pages is int last && p > last))
            {
                read.Lower(ResponseVerdict.Partial, "paging:" + paging.Rows + " (empty, the total says otherwise)");
            }

            if (rows == 0 && total == null)
            {
                read.Lower(ResponseVerdict.Partial, "paging:" + paging.Total + " (an empty page without its total)");
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
        private static void ReadFields(ResourceSchema schema, JsonElement element, ContractRead read, ContractRead into, string prefix)
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

                if (field.Fact != null)
                {
                    read.Note(field.Fact, FactState.Known);
                }

                if (field.Type == FieldType.Object)
                {
                    var members = new ContractRead();
                    if (field.Members != null)
                    {
                        ReadFields(field.Members, value, read, members, path + ".");
                    }

                    into.Set(field.Name, FieldType.Object, members);
                }
                else if (field.Type == FieldType.List)
                {
                    into.Set(field.Name, FieldType.List, field.Members != null ? ReadRows(field, value, read, path) : Array.Empty<ContractRead>());
                }
                else
                {
                    into.Set(field.Name, field.Type, parsed!);
                }
            }
        }

        // A list's rows: a row JE can't read (not an object, a required field missing or bad) is what the list declares;
        // a row's unknown fact or unreadable display field makes the answer Partial. Returns the usable rows, in order.
        private static IReadOnlyList<ContractRead> ReadRows(FieldRule field, JsonElement list, ContractRead read, string path)
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
                    ReadFields(field.Members!, row, rowRead, rowRead, path + "[].");
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

        /// <summary>
        /// Checks an answer against the request's facts by the contract's bindings (review round 10, D53 "derived request
        /// bindings"; the one binder of every contract). For each fact the request names: a <see cref="BindingKind.Route"/>
        /// fact is the contract itself (a request of another kind: Malformed); an <see cref="BindingKind.Echo"/> fact must be
        /// echoed by every required path (missing or null, on the answer or on any row of a row path: UNBOUND, so Partial:
        /// never definitive, never kept, never clearing) and agreed with by every path that is there (another value: the
        /// binding's mismatch verdict). A row path binds the rows there are (a list without rows has none to check).
        /// Diagnostics are fixed codes and the declared path only (4c2-R10-6).
        /// </summary>
        /// <param name="schema">The contract.</param>
        /// <param name="request">What was asked for.</param>
        /// <param name="element">The answer.</param>
        /// <param name="read">The read to lower.</param>
        public static void Bind(ResourceSchema schema, AnswerRequest request, JsonElement element, ContractRead read)
        {
            foreach (var (fact, binding) in schema.Bindings ?? new Dictionary<RequestFact, FactBinding>())
            {
                if (request.Of(fact) is not { } asked)
                {
                    continue;
                }

                if (binding.Kind == BindingKind.Route)
                {
                    if (fact == RequestFact.Kind && !string.Equals(asked as string, schema.Name, StringComparison.Ordinal))
                    {
                        read.Lower(ResponseVerdict.Malformed, "binding:kind (another kind's contract)");
                    }

                    continue;
                }

                if (binding.Kind != BindingKind.Echo)
                {
                    continue;
                }

                foreach (var path in binding.Paths)
                {
                    // A row path binds the rows there are: a list without rows has none to carry the echo (its emptiness is
                    // the paging rules' and ProviderAbsence's to judge), a missing list reaches one missing value.
                    foreach (var leaf in Leaves(element, path.Path))
                    {
                        if (leaf is not JsonElement value || value.ValueKind == JsonValueKind.Null)
                        {
                            if (path.Required)
                            {
                                read.Unbind("unbound:" + path.Path + " (no echo of the " + FactCode(fact) + " asked for)");
                            }
                        }
                        else if (!EchoValue(asked, value))
                        {
                            read.Lower(binding.OnMismatch, "binding:" + path.Path + " (not the " + FactCode(fact) + " asked for)");
                        }
                    }
                }
            }
        }

        // The fixed name of a fact in diagnostics.
        private static string FactCode(RequestFact fact) => fact switch
        {
            RequestFact.MediaType => "media type",
            RequestFact.ListId => "list",
            RequestFact.SearchTmdbId => "search id",
            RequestFact.SearchExternalId => "external id",
            RequestFact.IdSet => "ids",
            _ => fact.ToString().ToLowerInvariant(),
        };

        // The values at a path: one per object reached (null where the last member is missing); a row path (`rows[]`) reaches
        // every row of the list; a missing or mistyped container on the way reaches one missing value; a list without rows
        // reaches none.
        private static List<JsonElement?> Leaves(JsonElement element, string path)
        {
            var current = new List<JsonElement?> { element };
            foreach (var segment in path.Split('.'))
            {
                var rows = segment.EndsWith("[]", StringComparison.Ordinal);
                var name = rows ? segment[..^2] : segment;
                var next = new List<JsonElement?>();
                foreach (var node in current)
                {
                    if (node is not JsonElement value || value.ValueKind != JsonValueKind.Object || !value.TryGetProperty(name, out var member))
                    {
                        next.Add(null);
                    }
                    else if (!rows)
                    {
                        next.Add(member);
                    }
                    else if (member.ValueKind == JsonValueKind.Array)
                    {
                        next.AddRange(member.EnumerateArray().Select(row => (JsonElement?)row));
                    }
                    else
                    {
                        next.Add(null);
                    }
                }

                current = next;
            }

            return current;
        }

        // An answer value equals the fact asked for: by canonical text (a whole number's digits, a string as it is; MDBList's
        // ids may be either), and for an id set, by membership.
        private static bool EchoValue(object asked, JsonElement value)
        {
            var text = value.ValueKind switch
            {
                JsonValueKind.Number when value.TryGetInt64(out var number) => number.ToString(CultureInfo.InvariantCulture),
                JsonValueKind.String => value.GetString(),
                _ => null,
            };
            if (text == null)
            {
                return false;
            }

            return asked switch
            {
                IReadOnlyCollection<int> set => set.Any(id => string.Equals(id.ToString(CultureInfo.InvariantCulture), text, StringComparison.Ordinal)),
                int number => string.Equals(number.ToString(CultureInfo.InvariantCulture), text, StringComparison.Ordinal),
                string expected => string.Equals(expected, text, StringComparison.Ordinal),
                _ => false,
            };
        }

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
