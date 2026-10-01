using System;
using System.Collections.Frozen;
using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution
{
    /// <summary>
    /// Port of <c>js/tags/genretags.js</c>: the first three genres, each mapped to a Material
    /// Symbols glyph name by its lowercased name (default "theaters").
    /// </summary>
    internal static class GenreIcons
    {
        /// <summary>The web shows at most this many genres.</summary>
        public const int MaxGenres = 3;

        /// <summary>Icon for genres missing from the map.</summary>
        public const string DefaultIcon = "theaters";

        // genretags.js genreIconMap, verbatim. The web looks keys up by genreName.toLowerCase(), so
        // the mixed-case key "НФ и Фэнтези" can never match; it is kept as-is for parity.
        private static readonly FrozenDictionary<string, string> Map = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            // English
            ["action"] = "sports_martial_arts", ["adventure"] = "explore", ["animation"] = "animation",
            ["comedy"] = "mood", ["crime"] = "local_police", ["documentary"] = "article",
            ["drama"] = "theater_comedy", ["family"] = "family_restroom", ["fantasy"] = "auto_awesome",
            ["history"] = "history_edu", ["horror"] = "skull", ["music"] = "music_note",
            ["mystery"] = "psychology_alt", ["romance"] = "favorite", ["science fiction"] = "science",
            ["sci-fi"] = "science", ["tv movie"] = "tv", ["thriller"] = "psychology", ["war"] = "military_tech",
            ["western"] = "landscape", ["superhero"] = "domino_mask", ["musical"] = "music_video",
            ["biography"] = "menu_book", ["sport"] = "sports_soccer", ["game-show"] = "quiz",
            ["reality-tv"] = "live_tv",

            // French (fr)
            ["aventure"] = "explore", ["comédie"] = "mood", ["drame"] = "theater_comedy", ["fantastique"] = "auto_awesome",
            ["histoire"] = "history_edu", ["horreur"] = "skull", ["musique"] = "music_note", ["mystère"] = "psychology_alt",
            ["science-fiction"] = "science", ["téléfilm"] = "tv", ["guerre"] = "military_tech", ["comédie musicale"] = "music_video",
            ["biographie"] = "menu_book", ["familial"] = "family_restroom", ["historique"] = "history_edu",
            ["jeu-concours"] = "quiz", ["télé-réalité"] = "live_tv",

            // Spanish (es)
            ["acción"] = "sports_martial_arts", ["aventura"] = "explore", ["animación"] = "animation", ["comedia"] = "mood",
            ["crimen"] = "local_police", ["documental"] = "article", ["familiar"] = "family_restroom", ["fantasía"] = "auto_awesome",
            ["historia"] = "history_edu", ["terror"] = "skull", ["música"] = "music_note", ["misterio"] = "psychology_alt",
            ["ciencia ficción"] = "science", ["película de tv"] = "tv", ["suspense"] = "psychology", ["bélica"] = "military_tech",
            ["superhéroes"] = "domino_mask", ["biografía"] = "menu_book", ["deporte"] = "sports_soccer",
            ["concurso"] = "quiz", ["telerrealidad"] = "live_tv",

            // German (de)
            ["abenteuer"] = "explore", ["komödie"] = "mood", ["krimi"] = "local_police", ["dokumentarfilm"] = "article",
            ["familienfilm"] = "family_restroom", ["geschichte"] = "history_edu", ["kriegsfilm"] = "military_tech",
            ["musikfilm"] = "music_video", ["liebesfilm"] = "favorite", ["fernsehfilm"] = "tv",
            ["spielshow"] = "quiz",

            // Italian (it)
            ["azione"] = "sports_martial_arts", ["avventura"] = "explore", ["animazione"] = "animation", ["commedia"] = "mood",
            ["crimine"] = "local_police", ["documentario"] = "article", ["drammatico"] = "theater_comedy", ["famiglia"] = "family_restroom",
            ["fantastico"] = "auto_awesome", ["storico"] = "history_edu", ["orrore"] = "skull", ["musica"] = "music_note",
            ["mistero"] = "psychology_alt", ["romantico"] = "favorite", ["fantascienza"] = "science", ["film per la tv"] = "tv",
            ["guerra"] = "military_tech", ["biografico"] = "menu_book", ["sportivo"] = "sports_soccer",
            ["game show"] = "quiz", ["reality tv"] = "live_tv",

            // Danish (da)
            ["eventyr"] = "explore", ["komedie"] = "mood", ["dokumentar"] = "article",
            ["familie"] = "family_restroom", ["historie"] = "history_edu", ["gyser"] = "skull", ["musik"] = "music_note",
            ["mysterie"] = "psychology_alt", ["romantik"] = "favorite", ["krig"] = "military_tech", ["tv-film"] = "tv",
            ["spilshow"] = "quiz",

            // Swedish (sv)
            ["äventyr"] = "explore", ["komedi"] = "mood", ["brott"] = "local_police", ["dokumentär"] = "article",
            ["familj"] = "family_restroom", ["skräck"] = "skull",
            ["mysterium"] = "psychology_alt", ["krigs"] = "military_tech",
            ["spelshow"] = "quiz",

            // Hungarian (hu)
            ["akció"] = "sports_martial_arts", ["kaland"] = "explore", ["animációs"] = "animation", ["vígjáték"] = "mood",
            ["bűnügyi"] = "local_police", ["dokumentum"] = "article", ["dráma"] = "theater_comedy", ["családi"] = "family_restroom",
            ["történelmi"] = "history_edu", ["zenei"] = "music_note", ["misztikus"] = "psychology_alt",
            ["romantikus"] = "favorite", ["tv film"] = "tv", ["háborús"] = "military_tech",
            ["életrajzi"] = "menu_book", ["játékshow"] = "quiz", ["valóság-tv"] = "live_tv",

            // Russian (ru)
            ["боевик"] = "sports_martial_arts", ["приключения"] = "explore", ["мультфильм"] = "animation",
            ["комедия"] = "mood", ["криминал"] = "local_police", ["документальный"] = "article",
            ["драма"] = "theater_comedy", ["семейный"] = "family_restroom", ["фэнтези"] = "auto_awesome",
            ["история"] = "history_edu", ["ужасы"] = "skull", ["музыка"] = "music_note",
            ["детектив"] = "psychology_alt", ["мелодрама"] = "favorite", ["фантастика"] = "science",
            ["НФ и Фэнтези"] = "science", ["телевизионный фильм"] = "tv", ["триллер"] = "psychology", ["военный"] = "military_tech",
            ["вестерн"] = "landscape", ["реалити-шоу"] = "live_tv",
        }.ToFrozenDictionary(StringComparer.Ordinal);

        /// <summary>
        /// The genre chips the web renders for <paramref name="genres"/>, or null when it renders
        /// none (no genres, or a null genre among the first three, which throws in the web).
        /// </summary>
        public static List<GenreTag>? Resolve(string?[]? genres)
        {
            if (genres is null || genres.Length == 0) return null;
            var count = Math.Min(MaxGenres, genres.Length);
            var tags = new List<GenreTag>(count);
            for (var i = 0; i < count; i++)
            {
                var genre = genres[i];
                if (genre is null) return null;
                tags.Add(new GenreTag(genre, IconFor(genre)));
            }

            return tags;
        }

        /// <summary>The glyph name for one genre.</summary>
        public static string IconFor(string genre)
        {
            var key = JsText.ToLower(genre);
            if (Map.TryGetValue(key, out var icon)) return icon;

            // genreIconMap[key] is a plain-object lookup, so a lowercased name equal to an inherited
            // Object.prototype member finds that truthy non-string, and String(member) becomes the
            // icon span's text. Only the all-lowercase member names can match a lowercased genre.
            return key switch
            {
                "constructor" => ObjectConstructorText,
                "__proto__" => ObjectPrototypeText,
                _ => DefaultIcon,
            };
        }

        /// <summary>String(Object.prototype.constructor) in V8: the icon text for a genre named "constructor".</summary>
        internal const string ObjectConstructorText = "function Object() { [native code] }";

        /// <summary>String(Object.prototype): the icon text for a genre named "__proto__".</summary>
        internal const string ObjectPrototypeText = "[object Object]";
    }
}
