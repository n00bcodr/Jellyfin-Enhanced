using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources
{
    /// <summary>The entries of one chronolists.com watch order, read from its page.</summary>
    /// <param name="Title">List title (the universe's name).</param>
    /// <param name="Items">Entries in watch order (at most <see cref="ChronolistsPage.MaxItems"/>); an entry that couldn't be
    /// read is a keyless item at its place (a gap: runs never span it).</param>
    /// <param name="Total">Entries on the page.</param>
    /// <param name="Unusable">Entries that couldn't be read (unknown type, missing ids): the keyless items.</param>
    /// <param name="Truncated">The page has more than <see cref="ChronolistsPage.MaxItems"/> entries.</param>
    public sealed record ChronolistsList(string? Title, IReadOnlyList<SourceItem> Items, int Total, int Unusable, bool Truncated);

    /// <summary>
    /// Reads a chronolists.com watch-order page. The site has no API: each universe page is a Next.js page whose
    /// <c>&lt;script id="__NEXT_DATA__"&gt;</c> JSON holds <c>props.pageProps.universe.list</c>, in one of two shapes:
    /// <list type="bullet">
    /// <item><b>Rows</b> (until 2026): <c>l</c>, the entries in watch order. <c>t:"tv"</c> → <c>s</c>, <c>e</c> (numbers
    /// or numeric strings), <c>en</c> episode name, <c>rd</c> air date, <c>sid</c> TMDB season id; <c>t:"movie"</c> →
    /// <c>id</c> TMDB movie id, <c>n</c>, <c>ov</c>, <c>i</c> poster, <c>imdb</c>, <c>rd</c>.</item>
    /// <item><b>Columns</b> (since 2026; seen live 2026-10-18): <c>mi</c> the watch-order positions of the movies and
    /// <c>mv</c> their values (as a row movie); every other position is the next episode, whose columns are <c>sx</c>
    /// (index into <c>sk</c>, the TMDB season ids), <c>e</c>, <c>en</c>, <c>rd</c> (and <c>rt</c>, <c>eid</c>); the
    /// season number is the season's own <c>s</c> in <c>m</c>.</item>
    /// <item><c>m</c> (both): TMDB season id → <c>{n show name, sn season name, i season poster, id TMDB show id, imdb,
    /// tvdb, s season}</c>.</item>
    /// </list>
    /// Every entry therefore has exact TMDB ids and the metadata a placeholder needs, so no title lookup is needed. A
    /// page whose data has neither shape (or columns that don't line up) is reported as <see cref="FormatChanged"/>,
    /// never guessed at.
    /// </summary>
    public static class ChronolistsPage
    {
        /// <summary>Error: the page no longer has the expected data (site changed).</summary>
        public const string FormatChanged = "source_format_changed";

        /// <summary>Error: the page exists but isn't a watch order (e.g. /help).</summary>
        public const string NotAWatchOrder = "not_found";

        /// <summary>Entry cap per page (the largest universes have about 1450 entries).</summary>
        public const int MaxItems = 5000;

        /// <summary>
        /// Unreadable entries above this share of the page (percent) mean the entry shape changed
        /// (<see cref="FormatChanged"/>); below it the fetch is partial (the saved dctv and mcu pages have none).
        /// </summary>
        public const int MaxUnusablePercent = 10;

        /// <summary>A known entry type (tv, movie) with at least this many entries, none of them readable, changed its shape.</summary>
        public const int WholeTypeMinimum = 5;

        private const string Marker = "id=\"__NEXT_DATA__\"";
        private static readonly Regex PosterRegex = new("^/[A-Za-z0-9_-]+\\.(jpg|png)$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex ImdbRegex = new("^tt[0-9]{5,10}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

        /// <summary>Reads a page.</summary>
        /// <param name="html">The page HTML.</param>
        /// <param name="list">The entries.</param>
        /// <param name="error">Error code (<see cref="FormatChanged"/> or <see cref="NotAWatchOrder"/>) when the page can't be read.</param>
        /// <returns>Whether the page held a watch order.</returns>
        public static bool TryRead(string html, out ChronolistsList? list, out string? error)
        {
            list = null;
            error = FormatChanged;
            var json = NextData(html);
            if (json == null)
            {
                return false;
            }

            JsonDocument document;
            try
            {
                document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 64 });
            }
            catch (JsonException)
            {
                return false;
            }

            using (document)
            {
                var root = document.RootElement;
                if (!TryObject(root, "props", out var props) || !TryObject(props, "pageProps", out var pageProps))
                {
                    return false;
                }

                if (!TryObject(pageProps, "universe", out var universe))
                {
                    // Another kind of page (help, about…) is a wrong address; the watch-order page without its data is a change.
                    var page = root.TryGetProperty("page", out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;
                    error = page != null && page != "/[universe]" ? NotAWatchOrder : FormatChanged;
                    return false;
                }

                if (!TryObject(universe, "list", out var data) || !TryObject(data, "m", out var seasons))
                {
                    return false;
                }

                IEnumerable<(string? Type, SourceItem? Item)> entries;
                int total;
                if (data.TryGetProperty("l", out var rows) && rows.ValueKind == JsonValueKind.Array)
                {
                    total = rows.GetArrayLength();
                    entries = rows.EnumerateArray().Select(entry => (
                        entry.ValueKind == JsonValueKind.Object && entry.TryGetProperty("t", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null,
                        Read(entry, seasons)));
                }
                else if (Columns.TryCreate(data, seasons, out var columns))
                {
                    total = columns!.Total;
                    entries = columns.Entries();
                }
                else
                {
                    return false;
                }

                var items = new List<SourceItem>();
                var unusable = 0;
                // Per known type: entries seen and entries read (a type whose entries all fail changed its shape).
                int tvSeen = 0, tvRead = 0, movieSeen = 0, movieRead = 0;
                foreach (var (type, item) in entries)
                {
                    if (items.Count >= MaxItems)
                    {
                        break;
                    }

                    tvSeen += type == "tv" ? 1 : 0;
                    movieSeen += type == "movie" ? 1 : 0;
                    if (item == null)
                    {
                        // Kept as a keyless gap marker: it holds the entry's place, so runs never form across it and the
                        // fetch reports it as dropped (an id-less entry), and the fetch counts as partial.
                        unusable++;
                        items.Add(new SourceItem(type == "tv" ? "tv" : "movie", null, null, null, null, null, null, null, null));
                    }
                    else
                    {
                        tvRead += type == "tv" ? 1 : 0;
                        movieRead += type == "movie" ? 1 : 0;
                        items.Add(item);
                    }
                }

                var read = items.Count - unusable;
                if ((total > 0 && read == 0)
                    || (tvSeen >= WholeTypeMinimum && tvRead == 0) || (movieSeen >= WholeTypeMinimum && movieRead == 0)
                    || unusable * 100 > items.Count * MaxUnusablePercent)
                {
                    // Nothing readable, a whole kind of entry unreadable, or too many unreadable entries: the entry shape
                    // changed, so a "successful" fetch would silently miss part of the list.
                    return false;
                }

                error = null;
                list = new ChronolistsList(Text(universe, "name", ListRules.MaxTitle), items, total, unusable, total > items.Count);
                return true;
            }
        }

        // The JSON of <script id="__NEXT_DATA__" …>…</script> (attribute order and extra attributes don't matter).
        private static string? NextData(string html)
        {
            var at = html.IndexOf(Marker, StringComparison.Ordinal);
            if (at < 0)
            {
                return null;
            }

            var open = html.LastIndexOf("<script", at, StringComparison.OrdinalIgnoreCase);
            var start = html.IndexOf('>', at);
            if (open < 0 || start < 0)
            {
                return null;
            }

            var end = html.IndexOf("</script>", start, StringComparison.OrdinalIgnoreCase);
            return end < 0 ? null : html[(start + 1)..end];
        }

        // A row-format entry ("l").
        private static SourceItem? Read(JsonElement entry, JsonElement seasons)
        {
            if (entry.ValueKind != JsonValueKind.Object || !entry.TryGetProperty("t", out var type) || type.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            var date = Date(entry, "rd");
            switch (type.GetString())
            {
                case "tv":
                {
                    var seasonId = Number(entry, "sid");
                    var season = Number(entry, "s");
                    var episode = Number(entry, "e");
                    if (seasonId is not > 0 || season is not (>= 0 and <= 200) || episode is not (>= 0 and <= 9999)
                        || !seasons.TryGetProperty(seasonId.Value.ToString(CultureInfo.InvariantCulture), out var show) || show.ValueKind != JsonValueKind.Object)
                    {
                        return null;
                    }

                    return Episode(show, season.Value, episode.Value, Text(entry, "en", ListRules.MaxTitle), date);
                }

                case "movie":
                    return Movie(entry);

                default:
                    return null;
            }
        }

        // A movie (a row, or a column-format "mv" value): id, n, ov, i, imdb, rd.
        private static SourceItem? Movie(JsonElement entry)
        {
            if (entry.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            var id = Number(entry, "id");
            var title = Text(entry, "n", ListRules.MaxTitle);
            if (id is not > 0 || title == null)
            {
                return null;
            }

            var date = Date(entry, "rd");
            return new SourceItem("movie", id, Imdb(entry), null, title, Year(date), null, null, null)
            {
                Details = new SourceItemDetails(null, date, Poster(entry, "i"), Text(entry, "ov", ListRules.MaxOverview), null),
            };
        }

        // An episode of the season described by `show` (an "m" entry).
        private static SourceItem? Episode(JsonElement show, int season, int episode, string? episodeTitle, string? date)
        {
            var showId = Number(show, "id");
            var showName = Text(show, "n", ListRules.MaxTitle);
            if (showId is not > 0 || showName == null)
            {
                return null;
            }

            var tvdb = Number(show, "tvdb");
            return new SourceItem("tv", showId, Imdb(show), tvdb is > 0 ? tvdb : null, showName, Year(date), season, episode, null)
            {
                Details = new SourceItemDetails(episodeTitle, date, Poster(show, "i"), null, Text(show, "sn", ListRules.MaxTitle)),
            };
        }

        /// <summary>
        /// The column-format list: movie positions/values and episode columns, checked to line up before anything is read
        /// (a column of another length, positions out of order or out of range = the shape changed).
        /// </summary>
        private sealed class Columns
        {
            private JsonElement _seasons;
            private JsonElement[] _seasonKeys = System.Array.Empty<JsonElement>();
            private int[] _moviePositions = System.Array.Empty<int>();
            private JsonElement[] _movies = System.Array.Empty<JsonElement>();
            private JsonElement[] _seasonIndex = System.Array.Empty<JsonElement>();
            private JsonElement[] _episodes = System.Array.Empty<JsonElement>();
            private JsonElement[]? _names;
            private JsonElement[]? _dates;

            public int Total => _moviePositions.Length + _episodes.Length;

            public static bool TryCreate(JsonElement data, JsonElement seasons, out Columns? columns)
            {
                columns = null;
                if (!Array(data, "sk", out var seasonKeys) || !Array(data, "mi", out var positions) || !Array(data, "mv", out var movies)
                    || !Array(data, "sx", out var seasonIndex) || !Array(data, "e", out var episodes)
                    || positions.Length != movies.Length || seasonIndex.Length != episodes.Length)
                {
                    return false;
                }

                JsonElement[]? names = null;
                JsonElement[]? dates = null;
                if ((data.TryGetProperty("en", out _) && (!Array(data, "en", out names) || names!.Length != episodes.Length))
                    || (data.TryGetProperty("rd", out _) && (!Array(data, "rd", out dates) || dates!.Length != episodes.Length)))
                {
                    return false;
                }

                var total = positions.Length + episodes.Length;
                var moviePositions = new int[positions.Length];
                for (var i = 0; i < positions.Length; i++)
                {
                    // Watch-order positions: whole numbers, increasing, inside the list.
                    if (positions[i].ValueKind != JsonValueKind.Number || !positions[i].TryGetInt32(out var position)
                        || position < 0 || position >= total || (i > 0 && position <= moviePositions[i - 1]))
                    {
                        return false;
                    }

                    moviePositions[i] = position;
                }

                columns = new Columns
                {
                    _seasons = seasons,
                    _seasonKeys = seasonKeys,
                    _moviePositions = moviePositions,
                    _movies = movies,
                    _seasonIndex = seasonIndex,
                    _episodes = episodes,
                    _names = names,
                    _dates = dates,
                };
                return true;
            }

            // The entries in watch order: (type, item or null when unreadable).
            public IEnumerable<(string? Type, SourceItem? Item)> Entries()
            {
                var movie = 0;
                var episode = 0;
                for (var position = 0; position < Total; position++)
                {
                    if (movie < _moviePositions.Length && _moviePositions[movie] == position)
                    {
                        yield return ("movie", Movie(_movies[movie]));
                        movie++;
                        continue;
                    }

                    yield return ("tv", ReadEpisode(episode));
                    episode++;
                }
            }

            private SourceItem? ReadEpisode(int k)
            {
                var index = _seasonIndex[k];
                if (index.ValueKind != JsonValueKind.Number || !index.TryGetInt32(out var i) || i < 0 || i >= _seasonKeys.Length)
                {
                    return null;
                }

                var key = _seasonKeys[i];
                var seasonId = key.ValueKind == JsonValueKind.Number && key.TryGetInt32(out var number) ? number
                    : key.ValueKind == JsonValueKind.String && int.TryParse(key.GetString(), NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
                if (seasonId <= 0 || !_seasons.TryGetProperty(seasonId.ToString(CultureInfo.InvariantCulture), out var show) || show.ValueKind != JsonValueKind.Object)
                {
                    return null;
                }

                var season = Number(show, "s");
                var episode = Value(_episodes[k]);
                if (season is not (>= 0 and <= 200) || episode is not (>= 0 and <= 9999))
                {
                    return null;
                }

                var name = _names == null ? null : Text(_names[k], ListRules.MaxTitle);
                var dateText = _dates == null ? null : Text(_dates[k], 10);
                var date = dateText != null && ListRules.TryParseDate(dateText, out _) ? dateText : null;
                return Episode(show, season.Value, episode.Value, name, date);
            }

            private static bool Array(JsonElement data, string name, out JsonElement[] values)
            {
                values = System.Array.Empty<JsonElement>();
                if (!data.TryGetProperty(name, out var array) || array.ValueKind != JsonValueKind.Array)
                {
                    return false;
                }

                values = array.EnumerateArray().ToArray();
                return true;
            }
        }

        // A number or numeric string column value.
        private static int? Value(JsonElement value) => value.ValueKind switch
        {
            JsonValueKind.Number when value.TryGetInt32(out var number) && number is >= 0 and < 1_000_000_000 => number,
            JsonValueKind.String when int.TryParse(value.GetString(), NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed < 1_000_000_000 => parsed,
            _ => null,
        };

        // A string column value, cleaned and capped.
        private static string? Text(JsonElement value, int max)
        {
            if (value.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            var text = ListRules.CleanText(value.GetString());
            return text.Length == 0 ? null : text.Length > max ? text[..max] : text;
        }

        private static bool TryObject(JsonElement element, string name, out JsonElement value)
        {
            value = default;
            return element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out value) && value.ValueKind == JsonValueKind.Object;
        }

        // Numbers arrive as JSON numbers or numeric strings ("s":"1").
        private static int? Number(JsonElement element, string name)
        {
            if (!element.TryGetProperty(name, out var value))
            {
                return null;
            }

            return value.ValueKind switch
            {
                JsonValueKind.Number when value.TryGetInt32(out var number) && number is >= 0 and < 1_000_000_000 => number,
                JsonValueKind.String when int.TryParse(value.GetString(), NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed < 1_000_000_000 => parsed,
                _ => null,
            };
        }

        private static string? Text(JsonElement element, string name, int max)
        {
            if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            var text = ListRules.CleanText(value.GetString());
            return text.Length == 0 ? null : text.Length > max ? text[..max] : text;
        }

        private static string? Date(JsonElement element, string name)
        {
            var text = Text(element, name, 10);
            return text != null && ListRules.TryParseDate(text, out _) ? text : null;
        }

        private static string? Poster(JsonElement element, string name)
        {
            var text = Text(element, name, 200);
            return text != null && PosterRegex.IsMatch(text) ? text : null;
        }

        private static string? Imdb(JsonElement element)
        {
            var text = Text(element, "imdb", 12);
            return text != null && ImdbRegex.IsMatch(text) ? text : null;
        }

        private static int? Year(string? date) =>
            date != null && int.TryParse(date.AsSpan(0, 4), NumberStyles.None, CultureInfo.InvariantCulture, out var year) && year is >= 1870 and <= 2100 ? year : null;
    }
}
