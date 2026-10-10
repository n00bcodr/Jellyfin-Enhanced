using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources
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
    /// <c>&lt;script id="__NEXT_DATA__"&gt;</c> JSON holds <c>props.pageProps.universe.list</c>:
    /// <list type="bullet">
    /// <item><c>l</c>: the entries in watch order. <c>t:"tv"</c> → <c>s</c>, <c>e</c> (numbers or numeric strings),
    /// <c>en</c> episode name, <c>rd</c> air date, <c>sid</c> TMDB season id; <c>t:"movie"</c> → <c>id</c> TMDB movie id,
    /// <c>n</c>, <c>ov</c>, <c>i</c> poster, <c>imdb</c>, <c>rd</c>.</item>
    /// <item><c>m</c>: TMDB season id → <c>{n show name, sn season name, i season poster, id TMDB show id, imdb, tvdb}</c>.</item>
    /// </list>
    /// Every entry therefore has exact TMDB ids and the metadata a placeholder needs, so no title lookup is needed.
    /// A page whose data no longer has this shape is reported as <see cref="FormatChanged"/>, never guessed at.
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

                if (!TryObject(universe, "list", out var data)
                    || !data.TryGetProperty("l", out var entries) || entries.ValueKind != JsonValueKind.Array
                    || !TryObject(data, "m", out var seasons))
                {
                    return false;
                }

                var items = new List<SourceItem>();
                var unusable = 0;
                var total = entries.GetArrayLength();
                // Per known type: entries seen and entries read (a type whose entries all fail changed its shape).
                int tvSeen = 0, tvRead = 0, movieSeen = 0, movieRead = 0;
                foreach (var entry in entries.EnumerateArray())
                {
                    if (items.Count >= MaxItems)
                    {
                        break;
                    }

                    var type = entry.ValueKind == JsonValueKind.Object && entry.TryGetProperty("t", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
                    var item = Read(entry, seasons);
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
                list = new ChronolistsList(Text(universe, "name", PlaceholderRules.MaxTitle), items, total, unusable, total > items.Count);
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

                    var showId = Number(show, "id");
                    var showName = Text(show, "n", PlaceholderRules.MaxTitle);
                    if (showId is not > 0 || showName == null)
                    {
                        return null;
                    }

                    var tvdb = Number(show, "tvdb");
                    return new SourceItem("tv", showId, Imdb(show), tvdb is > 0 ? tvdb : null, showName, Year(date), season, episode, null)
                    {
                        Details = new SourceItemDetails(Text(entry, "en", PlaceholderRules.MaxTitle), date, Poster(show, "i"), null, Text(show, "sn", PlaceholderRules.MaxTitle)),
                    };
                }

                case "movie":
                {
                    var id = Number(entry, "id");
                    var title = Text(entry, "n", PlaceholderRules.MaxTitle);
                    if (id is not > 0 || title == null)
                    {
                        return null;
                    }

                    return new SourceItem("movie", id, Imdb(entry), null, title, Year(date), null, null, null)
                    {
                        Details = new SourceItemDetails(null, date, Poster(entry, "i"), Text(entry, "ov", PlaceholderRules.MaxOverview), null),
                    };
                }

                default:
                    return null;
            }
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

            var text = PlaceholderRules.CleanText(value.GetString());
            return text.Length == 0 ? null : text.Length > max ? text[..max] : text;
        }

        private static string? Date(JsonElement element, string name)
        {
            var text = Text(element, name, 10);
            return text != null && PlaceholderRules.TryParseDate(text, out _) ? text : null;
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
