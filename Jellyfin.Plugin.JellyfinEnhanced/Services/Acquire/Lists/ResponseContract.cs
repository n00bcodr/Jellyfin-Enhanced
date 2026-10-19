using System;
using System.Collections.Generic;
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

    /// <summary>The JSON type a declared field must have.</summary>
    internal enum FieldType
    {
        /// <summary>A positive integer (a TMDB id). 0 is empty.</summary>
        Id,

        /// <summary>A non-negative integer (a season or episode number, a count).</summary>
        Count,

        /// <summary>Any number.</summary>
        Number,

        /// <summary>A string ("" is empty).</summary>
        Text,

        /// <summary>A boolean.</summary>
        Bool,

        /// <summary>An IMDb id (<c>tt</c> + 5–10 digits); "" is empty.</summary>
        Imdb,

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
    internal sealed record FieldRule(string Name, FieldType Type, FieldRole Role, bool Nullable = true, ResourceSchema? Members = null, RowFailure Rows = RowFailure.Malformed, string? Fact = null);

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
    internal sealed record ResourceSchema(string Name, IReadOnlyList<FieldRule> Fields, IReadOnlyList<string>? Facts = null)
    {
        /// <summary>The same schema in Seerr's names (camelCase), e.g. <c>external_ids.imdb_id</c> → <c>externalIds.imdbId</c>.</summary>
        /// <param name="name">The camelCase schema's name.</param>
        /// <returns>The schema.</returns>
        public ResourceSchema Camel(string name) => new(name, Fields.Select(f => f with { Name = ResponseContract.CamelName(f.Name), Members = f.Members?.Camel(f.Members.Name) }).ToList(), Facts);

        /// <summary>This schema with more fields (another resource built on it).</summary>
        /// <param name="name">The new schema's name.</param>
        /// <param name="fields">Fields added.</param>
        /// <param name="facts">Identity facts.</param>
        /// <returns>The schema.</returns>
        public ResourceSchema With(string name, IEnumerable<FieldRule> fields, IReadOnlyList<string>? facts = null) => new(name, Fields.Concat(fields).ToList(), facts ?? Facts);

        /// <summary>Validates an answer (or one row) against this schema.</summary>
        /// <param name="element">The answer.</param>
        /// <returns>The verdict and the identity facts.</returns>
        public ContractRead Read(JsonElement element) => ResponseContract.Read(this, element);
    }

    /// <summary>One answer as validated: its verdict and the state of each identity fact.</summary>
    internal sealed class ContractRead
    {
        private readonly Dictionary<string, FactState> _facts = new(StringComparer.Ordinal);

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
    }

    /// <summary>
    /// The response contracts of every provider answer the list subsystem reads (review round 7, D53): one declared schema
    /// per resource kind, read by one validator. TMDB and Seerr title details, searches, <c>find</c> answers and seasons
    /// (the import lookups), and the placeholder-metadata resources (Seerr's, and TMDB's in Seerr's names for JE mode).
    /// List-source rows have their own per-provider row contract in the source fetcher's row readers (review rounds 4–5,
    /// 7): a row's key (its TMDB, IMDb or TVDB id; for Chronolists, an exact source, also its title) and declared type are
    /// required (missing, null, wrong type or empty: the row is malformed and the snapshot isn't complete); titles and
    /// years are display (unreadable: no value; a snapshot is complete by its keys).
    /// </summary>
    internal static class ResponseContract
    {
        private static readonly Regex ImdbRegex = new("^tt[0-9]{5,10}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

        private static FieldRule Required(string name, FieldType type, ResourceSchema? rows = null, RowFailure failure = RowFailure.Malformed) => new(name, type, FieldRole.Required, false, rows, failure);

        private static FieldRule Display(string name, FieldType type) => new(name, type, FieldRole.Display);

        private static FieldRule Fact(string name, FieldType type, bool nullable = true, ResourceSchema? rows = null) => new(name, type, FieldRole.Fact, nullable, rows);

        private static FieldRule Identity(string name, FieldType type, string fact) => new(name, type, FieldRole.Identity, true, Fact: fact);

        private static FieldRule Container(string name, bool nullable, params FieldRule[] members) => new(name, FieldType.Object, FieldRole.Container, nullable, new ResourceSchema(name, members));

        // ── Import lookups (TMDB's names; Seerr's are the camelCase of the same) ──

        /// <summary>A movie row of a search or find answer (also the title part of movie details).</summary>
        public static readonly ResourceSchema TmdbMovieRow = new("tmdb movie row", new[]
        {
            Required("id", FieldType.Id), Required("title", FieldType.Text), Display("original_title", FieldType.Text),
            Display("release_date", FieldType.Text), Display("poster_path", FieldType.Text), Display("overview", FieldType.Text),
            Display("popularity", FieldType.Number), Display("vote_count", FieldType.Count), Display("adult", FieldType.Bool),
        });

        /// <summary>A show row of a search or find answer (also the title part of TV details).</summary>
        public static readonly ResourceSchema TmdbTvRow = new("tmdb tv row", new[]
        {
            Required("id", FieldType.Id), Required("name", FieldType.Text), Display("original_name", FieldType.Text),
            Display("first_air_date", FieldType.Text), Display("poster_path", FieldType.Text), Display("overview", FieldType.Text),
            Display("popularity", FieldType.Number), Display("vote_count", FieldType.Count), Display("adult", FieldType.Bool),
        });

        private static readonly ResourceSchema TmdbSeasonRow = new("tmdb season row", new[]
        {
            Required("season_number", FieldType.Count), Display("episode_count", FieldType.Count), Display("air_date", FieldType.Text), Display("name", FieldType.Text),
        });

        private static readonly ResourceSchema TmdbEpisodeRow = new("tmdb episode row", new[]
        {
            Required("episode_number", FieldType.Count), Display("season_number", FieldType.Count), Display("name", FieldType.Text), Display("air_date", FieldType.Text),
        });

        private static readonly ResourceSchema TmdbEpisodeFindRow = new("tmdb episode find row", new[]
        {
            Required("show_id", FieldType.Id), Required("season_number", FieldType.Count), Required("episode_number", FieldType.Count),
            Display("name", FieldType.Text), Display("air_date", FieldType.Text),
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
            Fact("seasons", FieldType.List, nullable: false, rows: TmdbSeasonRow),
        }, new[] { "imdb", "tvdb" });

        /// <summary>A TMDB season: its episode list (an episode row JE can't read makes it Malformed).</summary>
        public static readonly ResourceSchema TmdbSeason = new("tmdb season", new[] { Required("episodes", FieldType.List, TmdbEpisodeRow) });

        /// <summary>TMDB's <c>find</c> for an IMDb EPISODE id: its episode results (a row JE can't read beside a usable one: Partial).</summary>
        public static readonly ResourceSchema TmdbEpisodeFind = new("tmdb episode find", new[] { Required("tv_episode_results", FieldType.List, TmdbEpisodeFindRow, RowFailure.Partial) });

        /// <summary>TMDB's <c>find</c> for a title's IMDb or TVDB id: both result lists (rows read by the lookup).</summary>
        public static readonly ResourceSchema TmdbFind = new("tmdb find", new[] { Required("movie_results", FieldType.List), Required("tv_results", FieldType.List) });

        /// <summary>A TMDB search answer: its result list (rows read by the lookup).</summary>
        public static readonly ResourceSchema TmdbSearch = new("tmdb search", new[] { Required("results", FieldType.List) });

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
            Required("id", FieldType.Id), Display("title", FieldType.Text), Fact("releaseDate", FieldType.Text), Fact("posterPath", FieldType.Text),
            Display("overview", FieldType.Text), Identity("imdbId", FieldType.Imdb, "imdb"),
            Container("externalIds", false, Identity("imdbId", FieldType.Imdb, "imdb")),
        }, new[] { "imdb" });

        private static readonly ResourceSchema MetadataEpisodeRef = new("metadata episode", new[]
        {
            Required("seasonNumber", FieldType.Count), Required("episodeNumber", FieldType.Count), Fact("airDate", FieldType.Text),
        });

        /// <summary>
        /// A show's placeholder metadata: first air date, poster, status (an ended show retires its entries), the season
        /// list with each season's episode count and air date (the expected episodes), the last and next aired episodes
        /// (Seerr leaves them out when there are none, so a missing one is none), and its IMDb and TVDB ids.
        /// </summary>
        public static readonly ResourceSchema MetadataShow = new("metadata show", new[]
        {
            Required("id", FieldType.Id), Display("name", FieldType.Text), Fact("firstAirDate", FieldType.Text), Fact("posterPath", FieldType.Text),
            Display("overview", FieldType.Text), Fact("status", FieldType.Text), Display("inProduction", FieldType.Bool),
            Container("externalIds", false, Identity("imdbId", FieldType.Imdb, "imdb"), Identity("tvdbId", FieldType.Id, "tvdb")),
            Fact("seasons", FieldType.List, nullable: false, rows: new ResourceSchema("metadata season row", new[]
            {
                Required("seasonNumber", FieldType.Count), Fact("episodeCount", FieldType.Count, nullable: false), Fact("airDate", FieldType.Text),
            })),
            new FieldRule("lastEpisodeToAir", FieldType.Object, FieldRole.Container, true, MetadataEpisodeRef),
            new FieldRule("nextEpisodeToAir", FieldType.Object, FieldRole.Container, true, MetadataEpisodeRef),
        }, new[] { "imdb", "tvdb" });

        /// <summary>A season's placeholder metadata: its episodes (with their air dates), air date and poster.</summary>
        public static readonly ResourceSchema MetadataSeason = new("metadata season", new[]
        {
            Required("episodes", FieldType.List, new ResourceSchema("metadata episode row", new[]
            {
                Required("episodeNumber", FieldType.Count), Display("seasonNumber", FieldType.Count), Display("name", FieldType.Text), Fact("airDate", FieldType.Text),
            })),
            Fact("airDate", FieldType.Text), Fact("posterPath", FieldType.Text),
        });

        /// <summary>A TMDB poster read (a title's or a season's details): <c>poster_path</c> is the answer (null: no poster).</summary>
        public static readonly ResourceSchema TmdbPoster = new("tmdb poster", new[] { Fact("poster_path", FieldType.Text) });

        /// <summary>Validates <paramref name="element"/> against <paramref name="schema"/>.</summary>
        /// <param name="schema">The schema.</param>
        /// <param name="element">The answer.</param>
        /// <returns>The verdict and identity facts.</returns>
        public static ContractRead Read(ResourceSchema schema, JsonElement element)
        {
            var read = new ContractRead();
            if (element.ValueKind != JsonValueKind.Object)
            {
                read.Lower(ResponseVerdict.Malformed, schema.Name);
                return read;
            }

            ReadFields(schema, element, read, string.Empty);
            foreach (var fact in schema.Facts ?? Array.Empty<string>())
            {
                if (read.Fact(fact) == FactState.Unknown)
                {
                    read.Lower(ResponseVerdict.Partial, fact);
                }
            }

            return read;
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

        private static void ReadFields(ResourceSchema schema, JsonElement element, ContractRead read, string prefix)
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

                if (!Typed(field.Type, value))
                {
                    read.Lower(field.Role == FieldRole.Display ? ResponseVerdict.Partial : ResponseVerdict.Malformed, path);
                    continue;
                }

                if (field.Fact != null)
                {
                    read.Note(field.Fact, FactState.Known);
                }

                if (field.Type == FieldType.Object && field.Members != null)
                {
                    ReadFields(field.Members, value, read, path + ".");
                }
                else if (field.Type == FieldType.List && field.Members != null)
                {
                    ReadRows(field, value, read, path);
                }
            }
        }

        // A list's rows: a row JE can't read (not an object, a required field missing or bad) is what the list declares;
        // a row's unknown fact or unreadable display field makes the answer Partial.
        private static void ReadRows(FieldRule field, JsonElement list, ContractRead read, string path)
        {
            var usable = 0;
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
                    ReadFields(field.Members!, row, rowRead, path + "[].");
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

                usable++;
                read.Lower(rowRead.Verdict, rowRead.Reason ?? path);
            }

            if (usable == 0 && unreadable > 0)
            {
                read.Lower(ResponseVerdict.Malformed, path);
            }
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

        // "" for text and ids, 0 for a TMDB id; an empty list or object is a value (read normally).
        private static bool Empty(FieldType type, JsonElement value) => type switch
        {
            FieldType.Text or FieldType.Imdb => value.ValueKind == JsonValueKind.String && value.GetString()!.Trim().Length == 0,
            FieldType.Id => value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var id) && id == 0,
            _ => false,
        };

        private static bool Typed(FieldType type, JsonElement value) => type switch
        {
            FieldType.Id => value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var id) && id > 0,
            FieldType.Count => value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var count) && count >= 0,
            FieldType.Number => value.ValueKind == JsonValueKind.Number,
            FieldType.Text => value.ValueKind == JsonValueKind.String,
            FieldType.Bool => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
            FieldType.Imdb => value.ValueKind == JsonValueKind.String && ImdbRegex.IsMatch(value.GetString()!.Trim()),
            FieldType.Object => value.ValueKind == JsonValueKind.Object,
            FieldType.List => value.ValueKind == JsonValueKind.Array,
            _ => false,
        };
    }
}
