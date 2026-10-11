/**
 * @file List placeholders: the bulk-import text parser ("Import list" → Paste).
 *
 * Pure and synchronous (no DOM, network or JE state): turns pasted text into ordered ParsedEntry objects that the
 * server's POST /list-placeholders/resolve endpoint matches against Seerr/TMDB. Handles numbered markdown catalogues
 * (`13. [Peacemaker - Season 1](url) (2022) · TV series · Released — note`), plain `Title (2019)` lines, markdown
 * tables (header detection: Watch/Title, Released/Year, Format/Type, Notes, Event/Block context and Seasons columns;
 * "A **or** B" and "A / B" alternatives with "2017 / 2021" years), `→` chains (`Flash **1x08** → Arrow **3x08**`),
 * episode notation (`1x08`, `S01E08`, `S8E01–05`, `8x01–05`), episodes given by title, season suffixes and lone
 * `Season N` lines, IMDb / Letterboxd / generic CSV exports, TMDB / IMDb / TVDB URLs and ids, type words and release
 * statuses. Headings, rules, blank lines and prose are skipped (headings become sections).
 *
 * Published as `JE.internals.listPlaceholders.parser` (merge-safe) and `JE.listPlaceholders.parser`.
 */
(function (JE) {
    'use strict';

    const MAX_ENTRIES = 2000;
    const MAX_LINES = 20000;
    const MAX_CSV_CHARS = 2_000_000;
    const MAX_TITLE = 200;
    const MAX_NOTE = 300;
    const MAX_EPISODES = 100;
    const MAX_EPISODE_NUMBER = 9999;
    const MAX_SEASON = 200;
    const MAX_PROSE_TITLE_WORDS = 15;
    const MIN_YEAR = 1870;
    const MAX_YEAR = 2100;

    // Parenthesised trailing qualifiers that describe the entry instead of naming it ("Swamp Thing (DCU film)").
    const QUALIFIER_WORDS = /\b(film|movie|series|animated|animation|live[- ]action|dcu|dceu|tv|pilot|compilation|edition|short|special|reported|proposed|presentation|anniversary|documentary|mini-?series|ova|anime|version|remaster(?:ed)?|director'?s cut|extended cut|theatrical cut)\b/i;

    // Trailing parentheticals that instruct rather than name ("Justice League Unlimited (save "Epilogue")") → note.
    const INSTRUCTION_PAREN = /\s*\(((?:save|saving|except|excluding|skip|skipping|without|minus|but not|not|ignore|ignoring|optional|optionally|leave|leaving|hold|holding|keep|keeping)\b[^()]{0,200})\)\s*$/i;

    // Type words (catalogue "· Kind ·" parts, table Format/Type cells, trailing qualifiers) → typeHint.
    const TV_TYPE = /\b(tv series|tv season|tv show|tv mini-?series|mini-?series|limited series|web series|short series|animated series|live[- ]action series|docu-?series|series|season|show|anime)\b/i;
    const MOVIE_TYPE = /\b(film|movie|feature|short|tv movie|documentary|mockumentary|video|ova)\b/i;
    // Formats that exist as films and as TV ("Compilation", "TV special", "Alternate edition", "Short collection"): no
    // hint of their own, so the matcher looks at both types; other words in the same text still decide ("compilation film").
    const NEUTRAL_TYPE = /\b(compilation|tv special|special|alternate edition|edition|short collection|collection)\b/gi;

    // Release statuses → released | scheduled | tba (anything without a firm release is "tba": review it).
    const STATUS_RULES = [
        [/\b(in development|development|announced|tba|tbd|shelved|cancel+ed|reported|uncertain|rumou?red|planned|unaired|unreleased|greenlit)\b/i, 'tba'],
        [/\b(scheduled|upcoming|post[- ]production|in production|filming|coming soon)\b/i, 'scheduled'],
        [/\b(released|available|aired|pilot only|out now|streaming)\b/i, 'released']
    ];

    const TMDB_URL = /themoviedb\.org\/(movie|tv)\/(\d{1,9})(?:-[^\s/?#)]*)?(?:\/season\/(\d{1,3})(?:\/episode\/(\d{1,4}))?)?/i;
    const TMDB_PREFIX = /\btmdb[:/]\s*(?:(movie|tv)[:/])?(\d{1,9})\b/i;
    const IMDB_ID = /\b(tt\d{7,10})\b/;
    const TVDB_PREFIX = /\btvdb[:/]\s*(\d{1,9})\b/i;
    // Inline id tokens and URLs (read by extractIds, then removed from titles and metadata).
    // Marks a markdown link's place while stripMarkdown runs (a private-use character, never in real text).
    const LINK_MARK = '\uE000';
    const ID_TOKENS = /\btmdb[:/]\s*(?:(?:movie|tv)[:/])?\d+\b|\btvdb[:/]\s*\d+\b|\btt\d{7,10}\b|https?:\/\/\S+/gi;
    // A markdown link labelled with a site or id rather than a title ("[TMDB](…)", "[IMDb](…)", "[tt1877830](…)").
    const ID_LINK_LABEL = /^(?:the\s*)?(?:tmdb|imdb|tvdb|movie\s*db|themoviedb|link|url|id|tt\d{7,10}|\d{1,9})$/i;
    // Words that make the text after a release year commentary rather than a type/status phrase ("watch before the
    // Batman movie", "sequel to the film").
    const LEAD_COMMENTARY = /\b(?:the|this|that|it|its|is|was|are|be|to|of|with|before|after|then|than|from|by|for|in|on|at|as|like|and|or|but|if|when|while|watch|see|read|skip|play|start|sequel|prequel|follows?|set)\b/i;
    // Where commentary starts after an episode reference or a season selector: a parenthetical other than a release
    // ("(2022)", "(2022-01-13)", "(2014–2015)", "(TBA)"; captured first, so a dash inside it isn't a separator either),
    // a spaced dash or a sentence end.
    const AFTER_SELECTOR = /([([]\s*(?:\d{4}(?:-\d{2}-\d{2})?|\d{4}\s*[–—-]\s*(?:\d{2,4})?|TBA|TBD)\s*[)\]])|\(|\s[—–-]\s+|[.;!?](?:\s|$)/i;
    const SEASON_SELECTOR = /\bseasons?\s+\d{1,3}(?:\s*[-–—]\s*\d{1,3})?\b/i;
    const RELEASE_YEAR = /[([]\s*(?:\d{4}(?:-\d{2}-\d{2})?|\d{4}\s*[–—-]\s*(?:\d{2,4})?)\s*[)\]]/;
    const TVDB_URL = /thetvdb\.com\/(?:\?[^\s]*?\bid=(\d{1,9})|dereferrer\/series\/(\d{1,9})|series\/(\d{1,9})(?:[/?#\s)]|$))/i;
    const LIST_URLS = [
        [/\bmdblist\.com\/lists\//i, 'mdblist'],
        [/\btrakt\.tv\/(users\/[^/\s]+\/(lists|watchlist)|lists\/|movies\/|shows\/)/i, 'trakt'],
        [/\bletterboxd\.com\/[^/\s]+\/(list|watchlist)\b|\bboxd\.it\//i, 'letterboxd'],
        [/\bimdb\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(list\/ls\d+|chart\/|user\/[^/\s]+\/watchlist)/i, 'imdb'],
        [/\bthemoviedb\.org\/(list|collection)\/\d+/i, 'tmdb'],
        [/\bchronolists\.com\/[a-z0-9][a-z0-9-]{0,63}\/?(?=$|[?#>)])/i, 'chronolists']
    ];

    // Instruction labels before a chain option ("Optional setup:", "Then:", "Part 2:").
    const CHAIN_LABEL = /^(?:(?:optional|required|recommended|bonus|extra)\s+)?(?:setup|optional|then|next|finally|start|start here|bonus|extra|prologue|epilogue|watch first|watch next|part \d+)$/i;
    // Small words a title-case show name may hold in lower case ("Legends of Tomorrow", "Star Wars: The Clone Wars").
    const TITLE_SMALL_WORDS = /^(?:a|an|and|the|of|in|on|at|to|for|from|by|with|or|nor|vs\.?|de|la|le|el|da|di|du|von|van)$/i;
    // A " / " piece of a chain option that is commentary on the piece before it ("optional", "skippable", "then …").
    const SLASH_COMMENTARY = /^(?:optional|optionally|skippable|skip|recommended|required|bonus|extra|or not)\b/i;

    // Episode notation: S01E08, S8E01–05, S01E01-E03, S1E5-S2E3 and 1x08, 8x01–05, 1x22-2x01.
    const SXE = /\bS(\d{1,3})\s?E(\d{1,4})(?:\s*[-–—]\s*(?:S(\d{1,3})\s?)?E?(\d{1,4}))?(?![\d])/i;
    const NXM = /(?:^|[^\w])(\d{1,3})x(\d{1,4})(?:\s*[-–—]\s*(?:(\d{1,3})x)?(\d{1,4}))?(?![\w])/i;
    const SEASON_EPISODE_WORDS = /\bseason\s+(\d{1,3})\s*,?\s*episodes?\s+(\d{1,4})(?:\s*[-–—]\s*(\d{1,4}))?\b/i;

    /**
     * Normalises typography that varies between sources (curly quotes, NBSP, zero-width characters).
     * @param {string} value Raw text.
     * @returns {string} Normalised text.
     */
    function normalizeTypography(value) {
        return String(value ?? '')
            .replace(/[​-‍﻿]/g, '')
            .replace(/[   ]/g, ' ')
            .replace(/[‘’‛′]/g, "'")
            .replace(/[“”‟″]/g, '"');
    }

    /**
     * Decodes the few HTML entities that survive copy/paste from rendered markdown.
     * @param {string} value Text.
     * @returns {string} Decoded text.
     */
    function decodeEntities(value) {
        return value
            .replace(/&nbsp;/gi, ' ')
            .replace(/&quot;/gi, '"')
            .replace(/&#0*39;|&apos;/gi, "'")
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&amp;/gi, '&');
    }

    /**
     * Removes markdown/HTML formatting and collects link targets (ids are read from them later).
     * @param {string} value Markdown text.
     * @param {string[]} [urls] Receives every link target and bare URL found.
     * @param {{url: string, label: string, at: number}[]} [links] Receives each markdown link's target and label with
     *     the offset of its label in the returned text (its real place, not a search for the label, so the same words
     *     earlier don't count).
     * @returns {string} Plain text.
     */
    function stripMarkdown(value, urls, links) {
        let text = String(value ?? '');
        text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
        const targets = [];
        text = text.replace(/\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g, (_, label, url) => {
            if (urls && url) urls.push(url);
            if (!links) return label;
            // A private-use marker keeps the link's place through the rest of the stripping; removed below.
            targets.push({ url, label });
            return LINK_MARK + label;
        });
        // Autolinks (<https://…>) are links, not HTML tags.
        text = text.replace(/<(https?:\/\/[^>\s]+)>/gi, '$1');
        if (urls) {
            const bare = text.match(/https?:\/\/[^\s<>()]+/g);
            if (bare) urls.push(...bare);
        }
        text = text.replace(/<br\s*\/?>/gi, ' ').replace(/<\/?[a-z][^>]*>/gi, '');
        text = decodeEntities(text);
        text = text.replace(/\*\*|__/g, '').replace(/`+/g, '');
        // Single-character emphasis only at word boundaries (keeps "snake_case" and "5*").
        text = text.replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2');
        text = text.replace(/\s+/g, ' ').trim();
        if (!links) return text;
        let plainText = '';
        let from = 0;
        let k = 0;
        for (let at = text.indexOf(LINK_MARK); at >= 0; at = text.indexOf(LINK_MARK, from)) {
            plainText += text.slice(from, at);
            if (targets[k] && targets[k].url) links.push({ url: targets[k].url, label: targets[k].label, at: plainText.length });
            k++;
            from = at + 1;
        }
        plainText += text.slice(from);
        // A marker standing alone between spaces (empty label) leaves a double space; stripping never produces one.
        return plainText.replace(/\s+/g, ' ').trim();
    }

    /**
     * Cuts a string to a maximum length on a character boundary.
     * @param {string} value Text.
     * @param {number} max Maximum length.
     * @returns {string} Possibly shortened text.
     */
    function clip(value, max) {
        const text = String(value ?? '').trim();
        return text.length > max ? text.slice(0, max).trim() : text;
    }

    /**
     * Parses a year in the accepted range.
     * @param {string|number} value Candidate.
     * @returns {number|undefined} The year.
     */
    function toYear(value) {
        const year = Number(value);
        return Number.isInteger(year) && year >= MIN_YEAR && year <= MAX_YEAR ? year : undefined;
    }

    /**
     * Reads a release value: "2013", "2024-12-05", "2012–2020", "2019–20", "TBA".
     * @param {string} value Cell or parenthesised text.
     * @returns {{year?: number, date?: string, status?: string}|null} Release facts, or null when it isn't one.
     */
    function parseRelease(value) {
        const text = String(value ?? '').trim();
        if (/^(tba|tbd|tbc|unknown|n\/a|—|-)$/i.test(text)) {
            return { status: 'tba' };
        }

        let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
        if (match) {
            const year = toYear(match[1]);
            return year ? { year, date: `${match[1]}-${match[2]}-${match[3]}` } : null;
        }

        match = /^(\d{4})(?:\s*[–—-]\s*(?:\d{2}|\d{4})?)?$/.exec(text);
        if (match) {
            const year = toYear(match[1]);
            return year ? { year } : null;
        }

        return null;
    }

    /**
     * Maps free text to a type hint.
     * @param {string} value Kind words.
     * @returns {'movie'|'tv'|undefined} Type hint.
     */
    function typeFromWords(value) {
        const text = String(value ?? '');
        if (!text) return undefined;
        if (/\bpilot\b|\bserial\b|\bunreleased project\b/i.test(text) && !TV_TYPE.test(text.replace(/\bpilot\b/i, ''))) {
            return undefined;
        }
        if (TV_TYPE.test(text)) return 'tv';
        if (MOVIE_TYPE.test(text.replace(NEUTRAL_TYPE, ' '))) return 'movie';
        return undefined;
    }

    /**
     * Whether free text holds nothing but type and status words ("TV series", "Released", "a TV movie").
     * @param {string} value Text.
     * @returns {boolean} Only type/status words.
     */
    function onlyTypeWords(value) {
        let text = String(value ?? '');
        for (const pattern of [TV_TYPE, MOVIE_TYPE, NEUTRAL_TYPE, ...STATUS_RULES.map(rule => rule[0]), /\b(?:a|an|the)\b/i]) {
            text = text.replace(new RegExp(pattern.source, 'gi'), ' ');
        }
        return !/[a-z]/i.test(text);
    }

    /**
     * Splits the text after a release year into a leading type/status phrase and the commentary after it. The lead runs
     * up to the first comma, semicolon, parenthetical, spaced dash or sentence end; it is metadata when it names a type
     * or status in at most five words and holds no instruction or function words ("Live-action film", "Disney+
     * miniseries", "Shelved film"; not "watch before the Batman movie").
     * @param {string} value Text after the year and its separator.
     * @returns {{lead: string, rest: string}} The metadata lead ('' when there is none) and the commentary.
     */
    function splitTypeLead(value) {
        const text = String(value ?? '').trim();
        if (onlyTypeWords(text)) return { lead: text, rest: '' }; // "TV series", "TV series, Released"
        const sep = /[,;(]|\s[—–-]\s|[.!?](?:\s|$)/.exec(text);
        const lead = (sep ? text.slice(0, sep.index) : text).trim();
        const rest = (sep ? text.slice(sep.index) : '').replace(/^[\s,;.!?—–-]+/, '').replace(/^\((.*)\)$/, '$1').trim();
        const metadata = lead && (onlyTypeWords(lead) || ((typeFromWords(lead) || statusFromWords(lead))
            && lead.split(/\s+/).length <= 5 && !LEAD_COMMENTARY.test(lead)));
        return metadata ? { lead, rest } : { lead: '', rest: text };
    }

    /**
     * Maps free text to a release status.
     * @param {string} value Status words.
     * @returns {'released'|'scheduled'|'tba'|undefined} Status.
     */
    function statusFromWords(value) {
        const text = String(value ?? '');
        for (const [pattern, status] of STATUS_RULES) {
            if (pattern.test(text)) return status;
        }
        return undefined;
    }

    /**
     * Collects TMDB / IMDb / TVDB ids from link targets and inline tokens.
     * @param {string} text Plain text of the entry.
     * @param {string[]} urls Link targets.
     * @returns {{ids: object|undefined, season?: number, episode?: number}} Ids plus a TMDB-URL season/episode.
     */
    function extractIds(text, urls) {
        const ids = {};
        let season;
        let episode;
        const haystacks = [...urls, text];
        for (const hay of haystacks) {
            const tmdb = TMDB_URL.exec(hay);
            if (tmdb && ids.tmdb === undefined) {
                ids.tmdb = Number(tmdb[2]);
                ids.tmdbType = tmdb[1].toLowerCase();
                if (tmdb[3] !== undefined) season = Number(tmdb[3]);
                if (tmdb[4] !== undefined) episode = Number(tmdb[4]);
            }
            const imdb = IMDB_ID.exec(hay);
            if (imdb && ids.imdb === undefined) ids.imdb = imdb[1];
            const tvdbUrl = TVDB_URL.exec(hay);
            if (tvdbUrl && ids.tvdb === undefined) ids.tvdb = Number(tvdbUrl[1] || tvdbUrl[2] || tvdbUrl[3]);
        }
        const tmdbPrefix = TMDB_PREFIX.exec(text);
        if (tmdbPrefix && ids.tmdb === undefined) {
            ids.tmdb = Number(tmdbPrefix[2]);
            if (tmdbPrefix[1]) ids.tmdbType = tmdbPrefix[1].toLowerCase();
        }
        const tvdbPrefix = TVDB_PREFIX.exec(text);
        if (tvdbPrefix && ids.tvdb === undefined) ids.tvdb = Number(tvdbPrefix[1]);
        return { ids: Object.keys(ids).length ? ids : undefined, season, episode };
    }

    /**
     * Detects a list/chart URL that belongs in the "From URL" tab rather than in a paste.
     * @param {string} text Line text.
     * @returns {string|undefined} The provider name.
     */
    function listUrlProvider(text) {
        for (const [pattern, provider] of LIST_URLS) {
            if (pattern.test(text)) return provider;
        }
        return undefined;
    }

    /**
     * Expands an episode range into coordinates of ONE season (episode numbers up to the server's 9999; split long
     * ranges with {@link episodeChunks}).
     * @param {number} season Season.
     * @param {number} from First episode.
     * @param {number} [to] Last episode.
     * @returns {{s: number, e: number}[]} Episodes.
     */
    function episodeRange(season, from, to) {
        const last = to !== undefined && to >= from ? Math.min(to, Math.max(from, MAX_EPISODE_NUMBER)) : from;
        const episodes = [];
        for (let e = from; e <= last; e++) episodes.push({ s: season, e });
        return episodes;
    }

    /**
     * Splits episodes into consecutive runs of at most {@link MAX_EPISODES} (one entry each), so a long range
     * ("One Piece 1x01-150") keeps every episode.
     * @param {{s: number, e: number}[]} episodes Episodes of one season.
     * @returns {{s: number, e: number}[][]} Runs (at least one).
     */
    function episodeChunks(episodes) {
        const chunks = [];
        for (let i = 0; i < episodes.length; i += MAX_EPISODES) chunks.push(episodes.slice(i, i + MAX_EPISODES));
        return chunks.length ? chunks : [episodes];
    }

    /**
     * The seasons of a "Seasons N–M" range, up to the server's season bound (200).
     * @param {number} from First season.
     * @param {number} to Last season (below `from`: none).
     * @returns {number[]} Seasons.
     */
    function seasonRange(from, to) {
        const seasons = [];
        for (let s = from; s <= Math.min(to, Math.max(from, MAX_SEASON)); s++) seasons.push(s);
        return seasons;
    }

    /**
     * Finds the first episode reference in a text.
     * @param {string} text Plain text.
     * @returns {{index: number, end: number, season: number, episodes: {s: number, e: number}[], openEnded?: boolean, more?: {season: number, episodes?: {s: number, e: number}[]}[]}|null}
     *   Where it is and what it names. A cross-season range (S1E5–S3E3) names the first season from its episode to the
     *   end (`openEnded`; a range starting at episode 1 is the whole season, no `episodes`), and `more` carries every
     *   later season: whole seasons in between, then the last season's episodes 1–N. A range of more than 100 episodes
     *   continues in `more` as further runs of the same season.
     */
    function findEpisodeRef(text) {
        const candidates = [];
        let match = SXE.exec(text);
        if (match) candidates.push({ index: match.index, end: match.index + match[0].length, s: +match[1], e: +match[2], s2: match[3], e2: match[4] });
        match = NXM.exec(text);
        if (match) {
            const offset = match[0].length - match[0].trimStart().length + (/^[^\w\d]/.test(match[0].trimStart()) ? 1 : 0);
            candidates.push({ index: match.index + offset, end: match.index + match[0].length, s: +match[1], e: +match[2], s2: match[3], e2: match[4] });
        }
        match = SEASON_EPISODE_WORDS.exec(text);
        if (match) candidates.push({ index: match.index, end: match.index + match[0].length, s: +match[1], e: +match[2], e2: match[3] });
        if (!candidates.length) return null;
        const best = candidates.sort((a, b) => a.index - b.index)[0];
        const toSeason = best.s2 !== undefined ? Number(best.s2) : best.s;
        if (toSeason !== best.s && toSeason > best.s) {
            // Cross-season range: one entry per season (C2) so nothing in between goes missing.
            const lastSeason = seasonRange(best.s, toSeason).at(-1);
            const more = [];
            for (let season = best.s + 1; season < lastSeason; season++) more.push({ season });
            if (lastSeason === toSeason) {
                for (const episodes of episodeChunks(episodeRange(lastSeason, 1, best.e2 !== undefined ? Number(best.e2) : 1))) more.push({ season: lastSeason, episodes });
            } else {
                more.push({ season: lastSeason });
            }
            return best.e <= 1
                ? { index: best.index, end: best.end, season: best.s, episodes: [], more }
                : { index: best.index, end: best.end, season: best.s, episodes: episodeRange(best.s, best.e), openEnded: true, more };
        }
        // A long range becomes consecutive entries of at most MAX_EPISODES episodes (`more`).
        const [episodes, ...rest] = episodeChunks(episodeRange(best.s, best.e, best.e2 !== undefined ? Number(best.e2) : undefined));
        const ref = { index: best.index, end: best.end, season: best.s, episodes };
        if (rest.length) ref.more = rest.map(run => ({ season: best.s, episodes: run }));
        return ref;
    }

    /**
     * Strips a season suffix: " - Season 1", " — season 2", ": Season 3", " (Season 2)", " Season 4", " S1", "Seasons 1-3".
     * @param {string} title Title text.
     * @returns {{title: string, seasons?: number[]}} Title without the suffix plus the season(s).
     */
    function splitSeasonSuffix(title) {
        const match = /(?:\s*[-–—:,]\s*|\s+|^)\(?seasons?\s+(\d{1,3})(?:\s*(?:[-–—]|to|&|and)\s*(\d{1,3}))?\)?\.?$/i.exec(title)
            || /\s+S(\d{1,3})$/.exec(title);
        if (!match) return { title };
        const from = Number(match[1]);
        const to = match[2] !== undefined ? Number(match[2]) : from;
        return { title: title.slice(0, match.index).trim(), seasons: seasonRange(from, to) };
    }

    /**
     * Removes descriptive trailing parentheticals ("(animated series)") and returns the type they imply.
     * @param {string} title Title.
     * @returns {{title: string, typeHint?: string, qualifier?: string}} Clean title.
     */
    function stripQualifiers(title) {
        let text = title;
        let typeHint;
        let qualifier;
        for (let guard = 0; guard < 3; guard++) {
            const match = /\s*\(([^()]{2,60})\)\s*$/.exec(text);
            if (!match || !QUALIFIER_WORDS.test(match[1]) || parseRelease(match[1])) break;
            qualifier = qualifier ? `${match[1]}; ${qualifier}` : match[1];
            typeHint = typeHint || typeFromWords(match[1]);
            text = text.slice(0, match.index).trim();
        }
        return { title: text, typeHint, qualifier };
    }

    /**
     * Moves a trailing instruction parenthetical ("(save "Epilogue")", "(skip the pilot)") out of a title.
     * @param {string} text Title text.
     * @returns {{text: string, note?: string}} The text without it, and the instruction as a note.
     */
    function splitInstruction(text) {
        const match = INSTRUCTION_PAREN.exec(text);
        if (!match || !match.index) return { text };
        return { text: text.slice(0, match.index).trim(), note: match[1].trim() };
    }

    /**
     * True when every "(" in a text is closed.
     * @param {string} text Text.
     * @returns {boolean} Balanced.
     */
    function balancedParens(text) {
        let depth = 0;
        for (const c of text) {
            if (c === '(') depth++;
            else if (c === ')' && --depth < 0) return false;
        }
        return depth === 0;
    }

    /**
     * Final title cleanup: quotes, list markers, dangling punctuation.
     * @param {string} title Raw title.
     * @returns {string} Clean title.
     */
    function cleanTitle(title) {
        let text = String(title ?? '').replace(/\s+/g, ' ').trim();
        text = text.replace(/^[-–—•*:;,.\s]+/, '').replace(/[\s,;:–—-]+$/, '').replace(/\.$/, '');
        const quoted = /^"(.+)"$/.exec(text);
        if (quoted) text = quoted[1].trim().replace(/[,;:]$|(?<![.])\.$/, '').trim();
        return clip(text, MAX_TITLE);
    }

    /**
     * True when a line reads like prose rather than a title entry.
     * @param {string} text Plain text (markers removed).
     * @returns {boolean} Whether to skip it.
     */
    function looksLikeProse(text) {
        const trimmed = text.trim();
        if (!trimmed) return true;
        if (/:$/.test(trimmed)) return true;
        const words = trimmed.split(/\s+/).length;
        if (words > 25) return true;
        if (words > 10 && /[a-z][.!?]\s+[A-Z]/.test(trimmed)) return true;
        if (words > 12 && /[.!?]$/.test(trimmed)) return true;
        return false;
    }

    /**
     * Builds a new entry with defaults and only meaningful keys.
     * @param {object} fields Entry fields.
     * @returns {object} ParsedEntry.
     */
    function makeEntry(fields) {
        const entry = {};
        for (const [key, value] of Object.entries(fields)) {
            if (value === undefined || value === null || value === '') continue;
            if (Array.isArray(value) && !value.length) continue;
            entry[key] = value;
        }
        if (entry.note) entry.note = clip(entry.note, MAX_NOTE);
        if (entry.episodes?.length) {
            entry.kind = 'episodes';
            entry.typeHint = 'tv';
            entry.season = entry.episodes[0].s;
        } else if (entry.episodeTitle || entry.imdbEpisode) {
            entry.kind = 'episodes';
            entry.typeHint = 'tv';
        } else if (entry.season !== undefined) {
            entry.kind = 'season';
            entry.typeHint = 'tv';
        } else if (entry.typeHint === 'tv') {
            entry.kind = 'series';
        } else if (entry.typeHint === 'movie') {
            entry.kind = 'movie';
        }
        if (entry.ids?.tmdbType && !entry.typeHint) entry.typeHint = entry.ids.tmdbType;
        return entry;
    }

    /**
     * Splits a title cell into alternatives ("A **or** B", "A / B").
     * @param {string} raw Raw (markdown) text.
     * @param {boolean} allowSlash Whether " / " separates alternatives here.
     * @returns {string[]} One or more raw parts.
     */
    function splitAlternatives(raw, allowSlash) {
        let parts = String(raw).split(/\s*(?:\*\*or\*\*|__or__|<b>or<\/b>|<strong>or<\/strong>)\s*/i);
        if (allowSlash) {
            parts = parts.flatMap(part => part.split(/\s+\/\s+/));
        }
        return parts.map(part => part.trim()).filter(Boolean);
    }

    /**
     * A season or episode selector at the start of a link's metadata (optionally after its year).
     * @param {string} meta Plain text after a leading markdown link.
     * @returns {{text: string, rest: string}|null} The selector (to append to the title) and the remaining metadata.
     */
    function leadingSelector(meta) {
        const yearParen = /^\s*([([]\s*(?:\d{4}(?:-\d{2}-\d{2})?|\d{4}\s*[–—-]\s*(?:\d{2,4})?|TBA|TBD)\s*[)\]])(.*)$/i.exec(meta);
        const year = yearParen ? yearParen[1] : '';
        const after = (yearParen ? yearParen[2] : meta).trim();
        // A dash or colon may separate the selector from the year: "(2022) - S1E1", "(2022) – 1x01".
        const selector = after.replace(/^[—–:-]\s*/, '');
        const head = selector.split(/\s+·\s+/)[0];
        const ref = findEpisodeRef(head);
        if (ref && ref.index <= 1) {
            return { text: head.slice(0, ref.end).trim(), rest: [year, selector.slice(ref.end).trim()].filter(Boolean).join(' ') };
        }
        const season = /^(?:[—–-]\s*)?(seasons?\s+\d{1,3}(?:\s*[-–—]\s*\d{1,3})?)\b(.*)$/i.exec(after);
        if (season) {
            return { text: `- ${season[1]}`, rest: [year, season[2].trim()].filter(Boolean).join(' ') };
        }
        return null;
    }

    /**
     * Parses one title-bearing text (a catalogue item, a plain line, a chain segment, a table cell).
     * @param {string} raw Raw markdown text of the item.
     * @param {object} ctx Context: line, raw line, section, defaults (year/date/typeHint/status/note) and flags.
     * @returns {object[]} Entries (usually one; seasons ranges and cross-season episode ranges give several).
     */
    function parseItem(raw, ctx) {
        const urls = [];
        let text = String(raw ?? '').trim();
        // A leading markdown link names the title; everything after it is metadata.
        let title;
        let meta = '';
        const link = /^\[([^\]]+)\]\(([^)\s]*)[^)]*\)\s*(.*)$/.exec(text);
        if (link) {
            urls.push(link[2]);
            title = stripMarkdown(link[1], urls);
            meta = keptLinks(link[3].replace(new RegExp(LINK_MARK, 'g'), ' '), urls);
            // A season/episode selector right after the link (or after its year) belongs to the title, as on plain
            // lines: "[The Flash](…) S01E08 (2014)", "[Peacemaker](…) — Season 1", "[Doctor Who](…) (2005) S1E11–S3E2".
            const selector = leadingSelector(meta);
            if (selector) {
                title = `${title} ${selector.text}`;
                meta = selector.rest;
            }
        } else {
            text = keptLinks(text.replace(new RegExp(LINK_MARK, 'g'), ' '), urls);
        }

        let year = ctx.year;
        let date = ctx.date;
        let status = ctx.status;
        let typeHint = ctx.typeHint;
        let note = ctx.note;
        let qualifier;
        let metaIds = '';

        if (title === undefined) {
            // "Title (2019) · Kind · Status — note" / "Title — note" / "Title"
            const parts = text.split(/\s+·\s+/);
            let head = parts.shift();
            meta = parts.join(' · ');
            const yearParen = /^(.*?\S)\s*[([]\s*(\d{4}(?:-\d{2}-\d{2})?|\d{4}\s*[–—-]\s*(?:\d{2,4})?|TBA|TBD)\s*[)\]](.*)$/i.exec(head);
            // A dash or colon may separate it from the year: "Peacemaker (2022) - S1E1", "Peacemaker (2022) – 1x01".
            const afterYear = yearParen ? yearParen[3].replace(/^\s*[—–:-]\s*/, ' ') : '';
            const yearRef = yearParen ? findEpisodeRef(afterYear) : null;
            if (yearRef && yearRef.index <= 1) {
                // "Doctor Who (2005) S1E11–S3E2": the episode reference after the year belongs to the title.
                title = `${yearParen[1]} ${afterYear.trim()}`;
                meta = [`(${yearParen[2]})`, meta].filter(Boolean).join(' · ');
            } else if (yearParen) {
                // "Peacemaker (2022) - Season 1": a season selector after the year belongs to the title as well.
                const selector = leadingSelector(yearParen[3]);
                title = selector ? `${yearParen[1]} ${selector.text}` : yearParen[1];
                const after = selector ? (selector.rest ? ` ${selector.rest}` : '') : yearParen[3];
                meta = [after.trim() ? `(${yearParen[2]})${after}` : `(${yearParen[2]})`, meta].filter(Boolean).join(' · ');
            } else {
                // Season suffixes use dashes too ("Peacemaker — season 1"): keep them on the title.
                const seasonDash = /^(.*?\S)\s+[—–-]\s+(seasons?\s+\d{1,3}(?:\s*[-–—]\s*\d{1,3})?)\b(.*)$/i.exec(head);
                if (seasonDash) {
                    title = `${seasonDash[1]} - ${seasonDash[2]}`;
                    const rest = seasonDash[3].replace(/^\s*[—–-]\s*/, '').trim();
                    if (rest) meta = [`— ${rest}`, meta].filter(Boolean).join(' · ');
                } else {
                    const noteSplit = /^(.*?\S)\s+[—–]\s+(.+)$/.exec(head);
                    if (noteSplit) {
                        title = noteSplit[1];
                        meta = [`— ${noteSplit[2]}`, meta].filter(Boolean).join(' · ');
                    } else {
                        title = head;
                    }
                }
            }
        }

        // Metadata: "(2022) · TV series · Released — 8 episodes. ..."
        if (meta) {
            const noteMatch = /\s[—–]\s(.+)$/.exec(` ${meta}`);
            let structured = meta;
            if (noteMatch) {
                note = noteMatch[1].trim();
                structured = ` ${meta}`.slice(0, noteMatch.index).trim();
            } else if (/^[—–]\s/.test(meta)) {
                note = meta.replace(/^[—–]\s*/, '');
                structured = '';
            }
            // Bare ids after the year ("Batman (1989) tt0096895", "… · tmdb:movie:268 · Film") name this title; they
            // are not type words ("movie" in tmdb:movie:268).
            // Bare URLs are left to the link targets kept above (none from the commentary).
            metaIds = (structured.match(ID_TOKENS) || []).filter(token => !/^https?:/i.test(token)).join(' ');
            structured = structured.replace(ID_TOKENS, ' ');
            // Commentary right after the release year ("(2014) - watch before the Batman movie", "(2014). Watch …") is
            // the note, not type or status words. A tail that starts with a short type/status phrase ("(1966) -
            // Live-action film", "(2022) - Shelved film (no public release)", "(2016) - Film, DCEU") keeps that phrase
            // as metadata; only the rest is the note.
            const parts = structured.split(/\s*·\s*/);
            const yearTail = /^(\s*[([][^)\]]*[)\]])\s*(?:[-:]\s+(?=\S)|[.;!?](?:\s+|$))(.*)$/.exec(parts[0]);
            if (yearTail && yearTail[2].trim()) {
                const tail = splitTypeLead(yearTail[2]);
                note = [tail.rest, note].filter(Boolean).join(' — ');
                parts[0] = [yearTail[1], tail.lead].filter(Boolean).join(' ');
                structured = parts.join(' · ');
            }
            const release = /[([]\s*([^)\]]+?)\s*[)\]]/.exec(structured);
            if (release) {
                const parsed = parseRelease(release[1]);
                if (parsed) {
                    if (parsed.year) year = parsed.year;
                    if (parsed.date) date = parsed.date;
                    if (parsed.status) status = parsed.status;
                }
            }
            for (const part of structured.replace(/[([][^)\]]*[)\]]/g, ' ').split(/\s*·\s*/)) {
                if (!part.trim()) continue;
                typeHint = typeFromWords(part) || typeHint;
                status = statusFromWords(part) || status;
            }
        }

        title = String(title ?? '');
        const instruction = splitInstruction(title);
        title = instruction.text;
        if (instruction.note) note = note ? `${instruction.note}; ${note}` : instruction.note;
        // Episodes given by title: Legends "Crisis on Infinite Earths: Part Five" (the quote follows the series name,
        // not an open parenthesis).
        let episodeTitle;
        const quotedEpisode = /^(.*?\S)\s*[—–:-]?\s*"([^"]{2,200})"\s*(.*)$/.exec(title);
        if (quotedEpisode && quotedEpisode[1].replace(/["\s]/g, '').length > 0 && balancedParens(quotedEpisode[1])) {
            episodeTitle = quotedEpisode[2].trim();
            title = quotedEpisode[1];
        }

        // Episode notation inside the title: "Flash 1x08", "The Flash S08E01-05".
        let episodeRef = null;
        if (!episodeTitle) {
            episodeRef = findEpisodeRef(title);
            if (episodeRef) {
                let after = title.slice(episodeRef.end).trim();
                title = title.slice(0, episodeRef.index);
                // Bare ids after the reference ("Flash S1E8 tmdb:tv:60735") name the title; they are never the note.
                const afterIds = after.match(ID_TOKENS);
                if (afterIds) {
                    // A bare URL here counts through the kept link targets (only before the commentary starts).
                    metaIds = [metaIds, ...afterIds.filter(token => !/^https?:/i.test(token))].filter(Boolean).join(' ');
                    after = after.replace(ID_TOKENS, ' ').replace(/\s+/g, ' ').trim();
                }
                if (!note && after && !/^[.,;:]?$/.test(after)) note = after.replace(/^[.,;:—–-]\s*/, '');
            }
        }

        // Trailing qualifiers and a trailing "(2019)" left on link titles.
        const trailingYear = /\s*[([](\d{4})[)\]]\s*$/.exec(title);
        if (trailingYear && toYear(trailingYear[1])) {
            year = year || toYear(trailingYear[1]);
            title = title.slice(0, trailingYear.index);
        }
        const qualified = stripQualifiers(title.trim());
        title = qualified.title;
        qualifier = qualified.qualifier;
        typeHint = typeHint || qualified.typeHint;

        let seasons;
        if (!episodeRef && !episodeTitle) {
            const seasonSplit = splitSeasonSuffix(title);
            if (seasonSplit.seasons) {
                title = seasonSplit.title;
                seasons = seasonSplit.seasons;
            }
        }

        const { ids, season: urlSeason, episode: urlEpisode } = extractIds([title, metaIds, ctx.idText].filter(Boolean).join(' '), urls);
        title = cleanTitle(title.replace(ID_TOKENS, ' '));
        if (!title && !ids) return [];
        if (title && !ids && title.split(/\s+/).length > MAX_PROSE_TITLE_WORDS) return [];
        if (!title && ids) title = '';

        const base = {
            index: undefined,
            line: ctx.line,
            raw: ctx.raw,
            section: ctx.section,
            source: ctx.source,
            title,
            year: date ? Number(date.slice(0, 4)) : year,
            date,
            typeHint,
            ids,
            // A note that is only an id link's site label ("— [IMDb](…)") says nothing.
            note: note && !/^(?:tmdb|imdb|tvdb|link)$/i.test(stripMarkdown(note)) ? stripMarkdown(note) : undefined,
            status,
            qualifier
        };

        if (episodeTitle) {
            return [makeEntry({ ...base, episodeTitle: clip(episodeTitle, MAX_TITLE), season: undefined })];
        }
        if (episodeRef) {
            const entries = [episodeRef.episodes.length
                ? makeEntry({ ...base, episodes: episodeRef.episodes, openEnded: episodeRef.openEnded || undefined })
                : makeEntry({ ...base, season: episodeRef.season })];
            for (const span of episodeRef.more || []) {
                entries.push(span.episodes ? makeEntry({ ...base, episodes: span.episodes }) : makeEntry({ ...base, season: span.season }));
            }
            return entries;
        }
        if (urlEpisode !== undefined && urlSeason !== undefined) {
            return [makeEntry({ ...base, episodes: episodeRange(urlSeason, urlEpisode) })];
        }
        if (urlSeason !== undefined) {
            return [makeEntry({ ...base, season: urlSeason })];
        }
        if (seasons) {
            return seasons.map(season => makeEntry({ ...base, season }));
        }
        return [makeEntry(base)];
    }

    /**
     * Strips a line's markdown and adds to `urls` only the link targets (markdown links, autolinks, bare URLs) that
     * start before its commentary ({@link commentaryStart}): a link in "— watch before [The Penguin](…)" or "(see
     * https://… for Legends)" is about another title. Bare non-URL id tokens stay in the text and count anywhere.
     * @param {string} value Raw markdown text.
     * @param {string[]} urls Receives the kept link targets.
     * @returns {string} The stripped text.
     */
    function keptLinks(value, urls) {
        const found = [];
        const links = [];
        const stripped = stripMarkdown(value, found, links);
        const located = locateLinks(stripped, found, links).sort((a, b) => a.at - b.at);
        const cut = commentaryStart(stripped, located);
        for (const link of located) {
            if (link.at < cut) urls.push(link.url);
        }
        return stripped;
    }

    /**
     * Whether the text at an offset (after spaces or "<") is a URL or a markdown link labelled with a site or id
     * ("[TMDB](…)", "[IMDb](…)"): after a separator it still names the entry, not another title.
     * @param {string} text Stripped text.
     * @param {number} at Offset.
     * @param {{url: string, label?: string, at: number}[]} links Located link targets of the text.
     * @returns {boolean} It names the entry.
     */
    function namesEntryAt(text, at, links) {
        const from = at + /^[\s<]*/.exec(text.slice(at))[0].length;
        return /^https?:/i.test(text.slice(from))
            || links.some(link => link.at === from && link.label !== undefined && ID_LINK_LABEL.test(stripMarkdown(link.label)));
    }

    /**
     * The first separator from an offset on that starts commentary: a match of `pattern` not followed by a URL or an
     * id link ({@link namesEntryAt}). A match of the pattern's first capture group (a release parenthetical) is skipped.
     * @param {string} text Stripped text.
     * @param {number} from Offset to search from.
     * @param {RegExp} pattern Separator pattern.
     * @param {{url: string, label?: string, at: number}[]} links Located link targets of the text.
     * @returns {number} Offset of the separator, or -1.
     */
    function separatorFrom(text, from, pattern, links) {
        const re = new RegExp(pattern.source, 'gi');
        re.lastIndex = from;
        for (let m = re.exec(text); m; m = re.exec(text)) {
            if (m[1] !== undefined) continue;
            if (!namesEntryAt(text, m.index + m[0].length, links)) return m.index;
            if (!m[0].length) re.lastIndex++;
        }
        return -1;
    }

    /**
     * Where the commentary of a plain line starts (its length when there is none): an em/en dash note (not one that
     * introduces a season, episode reference or year: "Peacemaker — Season 1", nor one inside a title before its
     * release year: "Mission: Impossible – Fallout (2018)"); after an episode reference or a season selector a
     * parenthetical other than a year, a spaced dash or a sentence end; after the release year a dash or colon
     * followed by words, a parenthetical or a sentence end. A URL or an id link ("[TMDB](…)") right after one of these
     * separators still belongs to the title ("Superman (2025) - https://…").
     * @param {string} text Stripped text.
     * @param {{url: string, label?: string, at: number}[]} [links] Located link targets of the text.
     * @returns {number} Offset of the commentary.
     */
    function commentaryStart(text, links = []) {
        let cut = text.length;
        const year = RELEASE_YEAR.exec(text);
        for (const dash of text.matchAll(/\s[—–]\s*/g)) {
            const before = text.slice(0, dash.index);
            if ((before.match(/[([]/g) || []).length > (before.match(/[)\]]/g) || []).length) continue; // "(2012 – 2020)"
            const restAt = dash.index + dash[0].length;
            // A dash before the release year is part of the title (as parseItem reads it), unless a link sits between
            // them ("The Batman — sequel to [Joker](…) (2019)").
            if (year && dash.index < year.index && !links.some(link => link.at >= restAt && link.at < year.index)) continue;
            const rest = text.slice(restAt);
            const ref = findEpisodeRef(rest);
            if (/^(?:seasons?\s+\d|[([]\s*\d{4})/i.test(rest) || (ref && ref.index === 0) || namesEntryAt(text, restAt, links)) continue;
            cut = dash.index;
            break;
        }
        const ref = findEpisodeRef(text);
        if (ref && ref.end < cut) {
            const at = separatorFrom(text, ref.end, AFTER_SELECTOR, links);
            if (at >= 0) cut = Math.min(cut, at);
        }
        const season = SEASON_SELECTOR.exec(text);
        if (season && season.index < cut) {
            // "Peacemaker (2022) - Season 1 (see [Arrow](…))", "Peacemaker - Season 1 - watch after […](…)".
            const at = separatorFrom(text, season.index + season[0].length, AFTER_SELECTOR, links);
            if (at >= 0) cut = Math.min(cut, at);
        }
        if (year && year.index < cut) {
            const end = year.index + year[0].length;
            const tail = text.slice(end);
            const selector = tail.replace(/^\s*[—–:-]?\s*/, '');
            const ref = findEpisodeRef(selector);
            if (!/^seasons?\s+\d/i.test(selector) && !(ref && ref.index === 0)) {
                const at = /^\s*(?:[-:]\s+(?=\S)|\(|[.;!?](?:\s|$))/.exec(tail);
                if (at && !namesEntryAt(text, end + at[0].length, links)) cut = Math.min(cut, end + at[0].search(/[-:(.;!?]/));
            }
        }
        return cut;
    }

    /**
     * Cleans one option of a `→` chain segment: drops a plain label ("Optional setup:") and the commentary after the
     * episode reference or first sentence; a trailing instruction parenthetical becomes a note. A prefix that carries
     * its own episode reference ("Supergirl 2x08: Medusa") is the entry, not a label. Bare ids in the commentary
     * after the reference ("Flash S1E8 tmdb:tv:60735") still name the title (returned with the link targets).
     * @param {string} raw Raw markdown text of the option.
     * @returns {{part: string, urls: string[], note?: string}} The title text, its link targets/ids and the instruction.
     */
    function cleanChainSegment(raw) {
        const found = [];
        const links = [];
        const stripped = stripMarkdown(String(raw ?? '').replace(new RegExp(LINK_MARK, 'g'), ' '), found, links);
        const instruction = splitInstruction(stripped);
        const plainPart = instruction.text;
        let part;
        const ref = findEpisodeRef(plainPart);
        // A plain label before an episode reference ("Optional setup: Supergirl 2x08"); the reference (or quoted
        // episode title) must follow the colon, so "Supergirl 2x08: Medusa" keeps its show and episode.
        // Before a numeric reference a short multi-word prefix is a label only when a title stands between the colon
        // and the reference ("Optional setup: Supergirl 2x08"); with the reference right after the colon the prefix is
        // the show ("The Flash: 1x08"). Before only a quoted episode title it must be a known instruction word, since
        // "The Flash: \"Invasion!\"" is a show and its episode.
        const label = /^([^:"]{2,40}):\s+(.+)$/.exec(plainPart);
        const instructionLabel = label && CHAIN_LABEL.test(label[1].trim());
        const afterRef = label ? findEpisodeRef(label[2]) : null;
        // A title-case prefix ("Star Trek: Discovery 1x08") is the show's own name, not a label: only an instruction
        // label or a prefix with a lowercase word ("Optional setup", "Watch this first") is dropped.
        const labelled = label && !findEpisodeRef(label[1])
            && (afterRef
                ? (instructionLabel || (afterRef.index > 0 && looksLikeInstruction(label[1])))
                : (/"[^"]+"/.test(label[2]) && instructionLabel));
        part = labelled ? label[2] : plainPart;
        // `part` is a suffix of `plainPart`, itself a prefix of the stripped text: offsets map back by this shift.
        const shift = plainPart.length - part.length;
        const located = locateLinks(stripped, found, links);
        const extra = [];
        let keptEnd;
        if (ref || /"[^"]+"/.test(part)) {
            // Keep the title + reference, drop the commentary after it (but not the bare ids in it).
            const inner = findEpisodeRef(part);
            const kept = inner ? part.slice(0, inner.end) : part.replace(/^(.*?"[^"]+")[\s\S]*$/, '$1');
            const tail = part.slice(kept.length);
            // Bare ids anywhere in the tail name the title ("Flash S1E8 tmdb:tv:60735"); a link target (bare URL or
            // markdown link) only before the commentary starts ("Flash 1x08 https://…", "Flash 1x08 [TMDB](…)"), not
            // one inside "(see https://…)" or after a dash (unless it is the URL or id link right after it).
            const partEnd = shift + part.length;
            const commentary = separatorFrom(stripped.slice(0, partEnd), shift + kept.length, /\(|\s[—–-]\s|[.;!?](?:\s|$)/, located);
            keptEnd = commentary < 0 ? partEnd : commentary;
            for (const token of tail.match(ID_TOKENS) || []) {
                if (!/^https?:/i.test(token)) extra.push(token);
            }
            part = kept;
        } else {
            // The first sentence, but a period after a title abbreviation ("Dr. No", "Vol. 2", "Mr. & Mrs. Smith",
            // "Monsters, Inc.") or ending a dotted initialism ("L.A. Confidential", "Agents of S.H.I.E.L.D.") is part of
            // the title. (A single letter isn't treated as an initial: "Movie B. See also …" ends there.)
            part = part.split(/(?<=[a-z0-9!?)])(?:(?<!\b(?:Dr|Mrs?|Ms|St|Vol|Pts?|Jr|Sr|No|vs|Ep|Mt|Ft|Ch|Bk|Inc|Co|Ltd|Bros))(?<!\b(?:[a-z]\.)+[a-z])\.|;)\s+/i)[0];
        }
        // Only link targets that start in the kept text (or, after an episode reference, before its commentary) name
        // the title; links in dropped commentary ("(see also [Legends](…))", "— then read [Crisis](…)", a second
        // sentence) are about other titles.
        keptEnd = keptEnd ?? shift + part.length;
        const urls = located.filter(link => link.at < keptEnd).map(link => link.url);
        for (const token of extra) {
            if (!urls.includes(token)) urls.push(token);
        }
        return { part, urls, note: instruction.note };
    }

    /**
     * Whether a prefix before a colon reads as an instruction label rather than part of a show's name: a known label
     * ("Optional setup", "Then") or one with a lowercase word other than a title's small words ("Watch this first").
     * @param {string} prefix Text before the colon.
     * @returns {boolean} An instruction label.
     */
    function looksLikeInstruction(prefix) {
        const text = prefix.trim();
        return CHAIN_LABEL.test(text) || text.split(/\s+/).some(word => /^[a-z]/.test(word) && !TITLE_SMALL_WORDS.test(word));
    }

    /**
     * Where each link target of a markdown text starts in its stripped text: a markdown link at its label (as
     * stripMarkdown placed it), a bare URL (or autolink) at the URL itself.
     * @param {string} stripped The stripped text.
     * @param {string[]} found Every link target stripMarkdown collected from it.
     * @param {{url: string, label: string, at: number}[]} links The markdown links with their label offsets, from stripMarkdown.
     * @returns {{url: string, at: number}[]} Each target with its offset in the stripped text.
     */
    function locateLinks(stripped, found, links) {
        const located = links.slice();
        const linked = new Set(links.map(link => link.url));
        for (const url of found) {
            if (linked.has(url)) continue;
            const at = stripped.indexOf(url);
            located.push({ url, at: at < 0 ? stripped.length : at });
        }
        return located;
    }

    /**
     * Splits text at " / " separators outside parentheses and brackets ("Flash 1x08 (part 1 / 2) / Arrow 3x09").
     * @param {string} text Raw text.
     * @returns {string[]} Trimmed, non-empty pieces.
     */
    function splitTopLevelSlash(text) {
        const pieces = [];
        let depth = 0;
        let start = 0;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (c === '(' || c === '[') depth++;
            else if ((c === ')' || c === ']') && depth > 0) depth--;
            else if (c === '/' && depth === 0 && /\s/.test(text[i - 1] || '') && /\s/.test(text[i + 1] || '')) {
                pieces.push(text.slice(start, i));
                start = i + 1;
            }
        }
        pieces.push(text.slice(start));
        return pieces.map(piece => piece.trim()).filter(Boolean);
    }

    /**
     * Plain " / " alternatives of a cleaned chain option ("Movie A / Movie B"): split at depth-0 " / " only (never
     * inside parentheses: "Blade Runner (theatrical / final cut)"), and never in commentary after an em or en dash
     * ("Justice League (2017) — skip / optional"), which stays with the last piece.
     * @param {string} text Cleaned option text.
     * @returns {string[]} The pieces (one when nothing splits).
     */
    function slashAlternatives(text) {
        const dash = /\s[—–]\s/.exec(text);
        const head = dash ? text.slice(0, dash.index) : text;
        const pieces = splitTopLevelSlash(head);
        if (!pieces.length) return [text.trim()].filter(Boolean);
        if (dash) pieces[pieces.length - 1] += text.slice(dash.index);
        return pieces;
    }

    /**
     * " / " alternatives of a chain option that each name their own episode or title ("[Flash](…) 1x08 /
     * [Arrow](…) 3x09", "[Justice League](tmdb…) / [Zack Snyder's Justice League](tmdb…)"): a piece counts when it has
     * an episode reference, a quoted episode title or its own id (a TMDB/IMDb/TVDB link or token). A piece with none
     * of these is commentary ("Supergirl 2x08 — optional / skippable") and stays with the piece before it. Null unless
     * at least two pieces count: the caller then cleans the option first and splits what is left (plain "A / B").
     * Each raw alternative is cleaned on its own, so it keeps its own link targets.
     * @param {string} option Raw option text.
     * @returns {string[]|null} Raw alternatives, or null.
     */
    function episodeAlternatives(option) {
        const pieces = splitTopLevelSlash(option).map((piece) => {
            const urls = [];
            const plainPiece = stripMarkdown(piece, urls);
            const ref = findEpisodeRef(plainPiece);
            return { piece, plainPiece, ref, counts: Boolean(ref || /"[^"]+"/.test(plainPiece) || extractIds(plainPiece, urls).ids) };
        });
        const episodic = pieces.some(p => p.ref);
        const merged = [];
        let counted = 0;
        let pending = '';
        for (const { piece, plainPiece, ref, counts } of pieces) {
            // A piece without its own reference or id is commentary on the piece before it only when it reads like
            // that: after a dash ("2x08 — optional / skippable"), an instruction word, or a piece of an episodic option
            // that names no episode. Otherwise it is a plain alternative of its own ("[A](…) / B / [C](…)").
            const previous = merged.length ? merged[merged.length - 1] : '';
            const commentary = !counts && (/\s[—–]\s/.test(stripMarkdown(previous)) || /^[a-z]/.test(plainPiece)
                || SLASH_COMMENTARY.test(plainPiece) || CHAIN_LABEL.test(plainPiece) || (episodic && !ref));
            if (commentary && merged.length) {
                merged[merged.length - 1] += ` / ${piece}`;
            } else if (commentary) {
                pending = pending ? `${pending} / ${piece}` : piece;
            } else {
                merged.push(pending ? `${pending} / ${piece}` : piece);
                pending = '';
                if (counts) counted++;
            }
        }
        if (pending && merged.length) merged[merged.length - 1] += ` / ${pending}`;
        return counted > 1 ? merged : null;
    }

    /**
     * Parses a `→` chain into its entries, in order. Episode segments keep only the first reference; label prefixes
     * ("Optional setup:", "**1918:**") and trailing prose are dropped.
     * @param {string} raw Raw markdown text containing arrows.
     * @param {object} ctx Item context.
     * @returns {object[]|null} Entries, or null when the text isn't a chain (a sentence that merely contains an arrow).
     */
    function parseChain(raw, ctx) {
        // Bold labels ("**1918:**") go before the arrows are split. A bold show name right before its episode reference
        // ("**The Flash:** 1x08") stays as plain "The Flash: 1x08", for cleanChainSegment's label rule to decide.
        const text = String(raw).replace(/\*\*([^*]{1,40}):\*\*\s*/g, (match, label, offset, whole) => {
            const ref = findEpisodeRef(stripMarkdown(whole.slice(offset + match.length)));
            return ref && ref.index === 0 ? `${label}: ` : '';
        }).replace(/^\s*[\w\s]{2,30}\border:\s*/i, '');
        const segments = text.split(/\s*(?:→|⟶|➔|➜|\s->\s)\s*/).map(s => s.trim()).filter(Boolean);
        if (segments.length < 2) return null;
        const plain = segments.map(s => stripMarkdown(s));
        const episodic = plain.some(s => findEpisodeRef(s) || /"[^"]+"/.test(s));
        if (!episodic && plain.some(s => s.length > 80)) return null;
        const entries = [];
        segments.forEach((segment, position) => {
            // "A **or** B" and "A / B" split on the raw segment, before cleaning cuts each option at its first episode
            // reference (which would drop " / B 3x09") or removes the bold marker (E2: always alternatives). Each
            // option then keeps its own link targets (ids). A " / " inside parentheses ("(part 1 / 2)") is no split,
            // and neither is one followed by commentary rather than another episode ("2x08 — optional / skippable").
            const options = splitAlternatives(segment, false).flatMap((option) => {
                const raw = ctx.allowSlash !== false ? episodeAlternatives(option) : null;
                if (raw) {
                    return raw.map((piece) => {
                        const cleaned = cleanChainSegment(piece);
                        return { part: cleaned.part, note: cleaned.note, urls: cleaned.urls };
                    });
                }
                const cleaned = cleanChainSegment(option);
                const pieces = ctx.allowSlash !== false ? slashAlternatives(cleaned.part) : [cleaned.part];
                // Link targets carry ids (TMDB/IMDb/TVDB URLs). When " / " splits the option further, each piece takes
                // the ids of its own raw piece (split at the same " / "), so one linked alternative keeps its id.
                const rawPieces = pieces.length > 1 ? slashAlternatives(option) : [];
                return pieces.map((part, i) => ({
                    part,
                    note: cleaned.note,
                    urls: pieces.length === 1 ? cleaned.urls : rawPieces.length === pieces.length ? cleanChainSegment(rawPieces[i]).urls : []
                }));
            });
            if (!options.length) return;
            const segmentCtx = { ...ctx, source: 'chain' };
            const parseOption = (option, idText) => parseItem(option.part, {
                ...segmentCtx,
                note: [option.note, ctx.note].filter(Boolean).join('; ') || undefined,
                idText: [...option.urls, idText].filter(Boolean).join(' ')
            });
            const parsed = options.length > 1
                ? withAlternatives(options.map(option => parseOption(option)), ctx)
                : parseOption(options[0], ctx.idText);
            for (const entry of parsed) {
                entry.chain = position;
                entries.push(entry);
            }
        });
        return entries;
    }

    /**
     * Folds alternative parses ("Justice League **or** Zack Snyder's Justice League") into ONE entry that lists them.
     * An alternative whose text gave several entries (a cross-season range, a range over MAX_EPISODES episodes, a
     * seasons range) keeps the later ones as `more` ({season, episodes?} scopes), added with it when it is chosen.
     * @param {object[][]} parsedLists The parse of each alternative (parseItem's entries).
     * @param {object} ctx Context (line, raw, section).
     * @returns {object[]} One entry with `alternatives`, or the single parse.
     */
    function withAlternatives(parsedLists, ctx) {
        const lists = parsedLists.filter(list => list && list.length);
        if (lists.length <= 1) return lists[0] || [];
        const first = lists[0][0];
        const entry = makeEntry({
            ...first,
            alternatives: lists.map(([p, ...rest]) => {
                const alt = { title: p.title };
                if (p.year) alt.year = p.year;
                if (p.date) alt.date = p.date;
                if (p.typeHint) alt.typeHint = p.typeHint;
                if (p.ids) alt.ids = p.ids;
                if (p.season !== undefined) alt.season = p.season;
                // Each alternative's own episodes ("Flash 1x08 **or** Arrow 3x09"), never the first one's.
                if (p.episodes?.length) alt.episodes = p.episodes;
                if (p.openEnded) alt.openEnded = true;
                const more = rest.filter(m => Number.isInteger(m.season) || m.episodes?.length).map((m) => {
                    const scope = { season: Number.isInteger(m.season) ? m.season : Number(m.episodes[0].s) };
                    if (m.episodes?.length) scope.episodes = m.episodes;
                    return scope;
                });
                if (more.length) alt.more = more;
                return alt;
            }),
            line: ctx.line,
            raw: ctx.raw
        });
        return [entry];
    }

    // ── Tables ──────────────────────────────────────────────────────────────

    /**
     * Splits a markdown table row into cells (escaped pipes stay in the cell).
     * @param {string} line Row text.
     * @returns {string[]} Cells.
     */
    function tableCells(line) {
        let text = line.trim();
        if (text.startsWith('|')) text = text.slice(1);
        if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
        return text.split(/(?<!\\)\|/).map(cell => cell.replace(/\\\|/g, '|').trim());
    }

    /**
     * True for a markdown table separator row (`| --- | :---: |`).
     * @param {string} line Row text.
     * @returns {boolean} Whether it separates header and body.
     */
    function isSeparatorRow(line) {
        return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line.trim());
    }

    /**
     * Assigns roles to table columns from their header text.
     * @param {string[]} header Header cells.
     * @returns {{title: number, year: number, type: number, note: number, context: number, seasons: boolean, ids: number}} Column indexes (-1 = none).
     */
    function tableRoles(header) {
        const roles = { title: -1, year: -1, type: -1, note: -1, context: -1, seasons: false, ids: -1 };
        header.forEach((cell, index) => {
            const name = stripMarkdown(cell).toLowerCase().replace(/[^a-z0-9 #]/g, ' ').replace(/\s+/g, ' ').trim();
            if (roles.title < 0 && /^(watch|title|name|film|films|movie|movies|series|show|shows|episode|episodes|item|entry|chapter order|exact chapter order|chapters|order|seasons|season|what to watch|watch order)$/.test(name)) {
                roles.title = index;
                roles.seasons = /^seasons?$/.test(name);
            } else if (roles.year < 0 && /^(released|release|release date|year|date|premiere|premiered|aired|air date|first aired|released on)$/.test(name)) {
                roles.year = index;
            } else if (roles.type < 0 && /^(format|type|kind|media type|category|medium)$/.test(name)) {
                roles.type = index;
            } else if (roles.note < 0 && /^(notes?|comments?|description|why|details)$/.test(name)) {
                roles.note = index;
            } else if (roles.context < 0 && /^(event|block|broadcast block|era|phase|crossover|arc|story|group)$/.test(name)) {
                roles.context = index;
            } else if (roles.ids < 0 && /^(tmdb|tmdb id|imdb|imdb id|tvdb|tvdb id|link|url|id)$/.test(name)) {
                roles.ids = index;
            }
        });
        return roles;
    }

    /**
     * Parses one table body row.
     * @param {string[]} cells Row cells.
     * @param {object} roles Column roles.
     * @param {object} ctx Line context.
     * @returns {object[]} Entries.
     */
    function parseTableRow(cells, roles, ctx) {
        const cell = index => (index >= 0 && index < cells.length ? cells[index] : '');
        const titleRaw = cell(roles.title);
        if (!stripMarkdown(titleRaw)) return [];
        const context = stripMarkdown(cell(roles.context));
        const contextYear = /\((\d{4})(?:\s*[–—-]\s*\d{2,4})?\)|^(\d{4})/.exec(context);
        // An id column's markdown links count by their targets ("[TMDB](https://www.themoviedb.org/movie/414906)").
        const idUrls = [];
        const idLabel = stripMarkdown(cell(roles.ids), idUrls);
        const rowCtx = { ...ctx, source: 'table', idText: [idLabel, ...idUrls].filter(Boolean).join(' ') };
        const note = [context, stripMarkdown(cell(roles.note))].filter(Boolean).join(' — ');
        if (note) rowCtx.note = note;
        const typeHint = typeFromWords(stripMarkdown(cell(roles.type)));
        if (typeHint) rowCtx.typeHint = typeHint;
        if (contextYear) rowCtx.year = toYear(contextYear[1] || contextYear[2]);

        // "Seasons" columns: "Arrow 3, Flash 1, Constantine 1" / "Flash 7–8".
        if (roles.seasons) {
            const entries = [];
            for (const item of stripMarkdown(titleRaw).split(/\s*[,;]\s*/)) {
                const match = /^(.+?)\s+(\d{1,2})(?:\s*[–—-]\s*(\d{1,2}))?\.?$/.exec(item.trim());
                if (!match || looksLikeProse(match[1]) || /\b(episodes?|and|the block)\b/i.test(match[1]) && match[1].split(' ').length > 3) continue;
                const from = Number(match[2]);
                const to = match[3] !== undefined ? Number(match[3]) : from;
                for (const season of seasonRange(from, to)) {
                    entries.push(makeEntry({ line: ctx.line, raw: ctx.raw, section: ctx.section, source: 'table', title: cleanTitle(match[1]), season, year: rowCtx.year, note: rowCtx.note }));
                }
            }
            return entries;
        }

        const plainTitle = stripMarkdown(titleRaw);
        if (/(→|⟶|➔|➜|\s->\s)/.test(plainTitle)) {
            return parseChain(titleRaw, { ...rowCtx, allowSlash: true }) || [];
        }

        const release = cell(roles.year);
        const releaseParts = release ? stripMarkdown(release).split(/\s+\/\s+|\s*\bor\b\s*/i) : [];
        const alternatives = splitAlternatives(titleRaw, true);
        if (alternatives.length > 1) {
            const parsed = alternatives.map((alt, i) => {
                const parsedRelease = parseRelease(releaseParts[i] ?? releaseParts[0] ?? '') || {};
                return parseItem(alt, { ...rowCtx, year: parsedRelease.year || rowCtx.year, date: parsedRelease.date, status: parsedRelease.status });
            });
            return withAlternatives(parsed, ctx);
        }

        const parsedRelease = parseRelease(stripMarkdown(release)) || {};
        return parseItem(titleRaw, { ...rowCtx, year: parsedRelease.year || rowCtx.year, date: parsedRelease.date, status: parsedRelease.status || statusFromWords(stripMarkdown(release)) });
    }

    // ── CSV ─────────────────────────────────────────────────────────────────

    /**
     * Parses RFC 4180 CSV (quoted fields, doubled quotes, newlines inside quotes).
     * @param {string} text CSV text.
     * @returns {{cells: string[], line: number, open?: boolean}[]} Rows with their 1-based starting line; `open` marks a
     *   last row whose quoted field never closes (an incomplete record).
     */
    function parseCsv(text) {
        const rows = [];
        let row = [];
        let field = '';
        let quoted = false;
        let line = 1;
        let rowLine = 1;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (quoted) {
                if (c === '"') {
                    if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
                } else {
                    if (c === '\n') line++;
                    field += c;
                }
            } else if (c === '"' && field === '') {
                quoted = true;
            } else if (c === ',') {
                row.push(field); field = '';
            } else if (c === '\n' || c === '\r') {
                if (c === '\r' && text[i + 1] === '\n') i++;
                row.push(field); field = '';
                rows.push({ cells: row, line: rowLine });
                row = [];
                line++;
                rowLine = line;
            } else {
                field += c;
            }
        }
        if (field !== '' || row.length || quoted) {
            row.push(field);
            rows.push(quoted ? { cells: row, line: rowLine, open: true } : { cells: row, line: rowLine });
        }
        return rows;
    }

    /**
     * Finds a CSV export header (IMDb, Letterboxd or a generic Title/Year sheet) near the top of the text.
     * @param {{cells: string[], line: number}[]} rows Parsed rows.
     * @returns {{format: string, headerIndex: number, columns: object}|null} The export format and column map.
     */
    function detectCsv(rows) {
        let found = null;
        const limit = Math.min(rows.length, 12);
        for (let i = 0; i < limit; i++) {
            const names = rows[i].cells.map(c => c.trim().toLowerCase());
            if (names.length < 2) continue;
            const col = name => names.indexOf(name);
            if (col('const') >= 0 && col('title') >= 0) {
                return { format: 'csv-imdb', headerIndex: i, columns: { title: col('title'), year: col('year'), imdb: col('const'), type: col('title type'), note: col('description'), date: col('release date') } };
            }
            if (col('name') >= 0 && col('year') >= 0 && (col('letterboxd uri') >= 0 || col('url') >= 0)) {
                // A Letterboxd list export starts with a list-metadata block; the LAST Name+Year header is the films.
                found = { format: 'csv-letterboxd', headerIndex: i, columns: { title: col('name'), year: col('year'), note: col('description') } };
                continue;
            }
            const titleCol = col('title') >= 0 ? col('title') : col('name');
            const idCols = ['tmdb', 'tmdb_id', 'tmdbid', 'imdb', 'imdb_id', 'imdbid', 'tvdb', 'tvdb_id', 'tvdbid'].map(col);
            if (!found && titleCol >= 0 && (col('year') >= 0 || idCols.some(c => c >= 0))) {
                found = {
                    format: 'csv',
                    headerIndex: i,
                    columns: {
                        title: titleCol, year: col('year'),
                        tmdb: [col('tmdb'), col('tmdb_id'), col('tmdbid')].find(c => c >= 0) ?? -1,
                        imdb: [col('imdb'), col('imdb_id'), col('imdbid')].find(c => c >= 0) ?? -1,
                        tvdb: [col('tvdb'), col('tvdb_id'), col('tvdbid')].find(c => c >= 0) ?? -1,
                        type: [col('type'), col('media_type'), col('mediatype'), col('kind')].find(c => c >= 0) ?? -1,
                        season: col('season'), episode: col('episode'),
                        note: [col('note'), col('notes'), col('description')].find(c => c >= 0) ?? -1
                    }
                };
            }
        }
        return found;
    }

    /**
     * Maps an IMDb "Title Type" to a type hint (null = not a watchable title: games, podcasts, people).
     * @param {string} value Title Type.
     * @returns {{typeHint?: string, episode?: boolean}|null} Mapping.
     */
    function imdbTitleType(value) {
        const type = String(value ?? '').trim().toLowerCase();
        if (!type) return {};
        if (/video game|podcast|music video|person/.test(type)) return null;
        if (/episode/.test(type)) return { typeHint: 'tv', episode: true };
        if (/series|mini/.test(type)) return { typeHint: 'tv' };
        return { typeHint: 'movie' };
    }

    /**
     * Turns CSV rows into entries.
     * @param {{cells: string[], line: number}[]} rows Rows.
     * @param {{format: string, headerIndex: number, columns: object}} csv Detected export.
     * @param {object} result Parse result to fill.
     * @param {number} maxEntries Entry cap.
     */
    function parseCsvEntries(rows, csv, result, maxEntries) {
        const { columns } = csv;
        const get = (cells, index) => (index !== undefined && index >= 0 && index < cells.length ? cells[index].trim() : '');
        for (let i = csv.headerIndex + 1; i < rows.length; i++) {
            const { cells, line } = rows[i];
            const raw = cells.join(',');
            if (!cells.some(c => c.trim())) continue;
            if (result.entries.length >= maxEntries) {
                result.truncated = true; // rows left over: tell the user
                break;
            }
            const title = cleanTitle(get(cells, columns.title));
            const year = toYear(get(cells, columns.year));
            const base = { line, raw: clip(raw, 500), section: result.currentSection, source: csv.format, title, year };
            if (csv.format === 'csv-imdb') {
                const mapping = imdbTitleType(get(cells, columns.type));
                const imdb = IMDB_ID.exec(get(cells, columns.imdb))?.[1];
                if (mapping === null || (!title && !imdb)) {
                    result.skipped.push({ line, raw: clip(raw, 500), reason: mapping === null ? 'unsupportedType' : 'empty' });
                    continue;
                }
                const date = /^\d{4}-\d{2}-\d{2}$/.test(get(cells, columns.date)) ? get(cells, columns.date) : undefined;
                result.entries.push(makeEntry({ ...base, date, typeHint: mapping.typeHint, ids: imdb ? { imdb } : undefined, imdbEpisode: mapping.episode || undefined, note: stripMarkdown(get(cells, columns.note)) }));
            } else if (csv.format === 'csv-letterboxd') {
                if (!title) { result.skipped.push({ line, raw: clip(raw, 500), reason: 'empty' }); continue; }
                result.entries.push(makeEntry({ ...base, typeHint: 'movie', note: stripMarkdown(get(cells, columns.note)) }));
            } else {
                const ids = {};
                const tmdb = Number(get(cells, columns.tmdb));
                if (Number.isInteger(tmdb) && tmdb > 0) ids.tmdb = tmdb;
                const imdb = IMDB_ID.exec(get(cells, columns.imdb))?.[1];
                if (imdb) ids.imdb = imdb;
                const tvdb = Number(get(cells, columns.tvdb));
                if (Number.isInteger(tvdb) && tvdb > 0) ids.tvdb = tvdb;
                if (!title && !Object.keys(ids).length) { result.skipped.push({ line, raw: clip(raw, 500), reason: 'empty' }); continue; }
                const typeHint = typeFromWords(get(cells, columns.type)) || (/^(tv|show)$/i.test(get(cells, columns.type)) ? 'tv' : undefined);
                if (ids.tmdb && typeHint) ids.tmdbType = typeHint;
                const season = Number(get(cells, columns.season));
                const episode = Number(get(cells, columns.episode));
                const fields = { ...base, typeHint, ids: Object.keys(ids).length ? ids : undefined, note: stripMarkdown(get(cells, columns.note)) };
                if (Number.isInteger(season) && season >= 0 && get(cells, columns.season) !== '') {
                    if (Number.isInteger(episode) && episode >= 0 && get(cells, columns.episode) !== '') fields.episodes = [{ s: season, e: episode }];
                    else fields.season = season;
                }
                result.entries.push(makeEntry(fields));
            }
        }
    }

    // ── Document ────────────────────────────────────────────────────────────

    /**
     * Parses pasted text into ordered import entries.
     *
     * ParsedEntry: `{ index, line, raw, section?, source, title, year?, date?, typeHint?: 'movie'|'tv',
     * kind?: 'movie'|'series'|'season'|'episodes', season?, episodes?: [{s,e}], episodeTitle?, openEnded?,
     * ids?: {tmdb?, tmdbType?, imdb?, tvdb?}, imdbEpisode?, note?, status?: 'released'|'scheduled'|'tba',
     * qualifier?, alternatives?: [{title, year?, date?, typeHint?, ids?, season?, episodes?, openEnded?}], chain?, dupOf? }`.
     *
     * @param {string} text Pasted text (markdown, plain lines or a CSV export).
     * @param {{maxEntries?: number}} [options] Options.
     * @returns {{format: string, entries: object[], skipped: {line: number, raw: string, reason: string, provider?: string}[],
     *   sections: {title: string, line: number, firstEntry: number}[], truncated: boolean}} The parse.
     */
    function parse(text, options) {
        const maxEntries = Math.max(1, Math.min(MAX_ENTRIES, Number(options?.maxEntries) || MAX_ENTRIES));
        const source = normalizeTypography(text).replace(/\r\n?/g, '\n');
        const result = { format: 'text', entries: [], skipped: [], sections: [], truncated: false, currentSection: undefined };

        const csvCut = source.length > MAX_CSV_CHARS;
        const csvText = csvCut ? source.slice(0, MAX_CSV_CHARS) : source;
        const csvRows = /,/.test(source.slice(0, 4000)) ? parseCsv(csvText) : [];
        const csv = csvRows.length > 1 ? detectCsv(csvRows) : null;
        if (csv) {
            result.format = csv.format;
            // The text ends inside a record (cut at the size cap, or a quoted field that never closes): not a row.
            const last = csvRows[csvRows.length - 1];
            if (csvRows.length - 1 > csv.headerIndex && (last.open || (csvCut && !csvText.endsWith('\n')))) {
                csvRows.pop();
                if (!csvCut) result.skipped.push({ line: last.line, raw: clip(last.cells.join(','), 500), reason: 'unterminated' });
            }
            if (csvCut) result.truncated = true;
            parseCsvEntries(csvRows, csv, result, maxEntries);
        } else {
            parseText(source, result, maxEntries);
        }

        if (result.entries.length > maxEntries) {
            result.entries.length = maxEntries;
            result.truncated = true;
        }
        finish(result);
        delete result.currentSection;
        return result;
    }

    /**
     * Parses markdown/plain text line by line.
     * @param {string} source Normalised text.
     * @param {object} result Parse result to fill.
     * @param {number} maxEntries Entry cap.
     */
    function parseText(source, result, maxEntries) {
        const lines = source.split('\n');
        if (lines.length > MAX_LINES) {
            lines.length = MAX_LINES;
            result.truncated = true;
        }
        let table = null; // {roles} while inside a markdown table body
        let seriesContext; // last series-ish title for lone "Season N" lines
        let seriesContextEntry; // index of a bare-title entry that only introduced the seasons below it

        for (let i = 0; i < lines.length; i++) {
            if (result.entries.length > maxEntries) { result.truncated = true; break; }
            const rawLine = lines[i];
            const trimmed = rawLine.trim();
            const lineNo = i + 1;
            const ctx = { line: lineNo, raw: clip(trimmed, 500), section: result.currentSection };

            if (!trimmed) { table = null; continue; }

            // Markdown table.
            if (trimmed.startsWith('|') || (table && trimmed.includes('|'))) {
                if (isSeparatorRow(trimmed)) continue;
                const cells = tableCells(trimmed);
                if (!table) {
                    if (i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
                        const roles = tableRoles(cells);
                        table = { roles };
                        if (roles.title < 0) {
                            result.skipped.push({ line: lineNo, raw: ctx.raw, reason: 'table' });
                        }
                        continue;
                    }
                    // Header-less table: first textual cell is the title.
                    table = { roles: { title: Math.max(0, cells.findIndex(c => /[a-z]/i.test(c) && !/^\d+$/.test(c))), year: -1, type: -1, note: -1, context: -1, seasons: false, ids: -1 }, headerless: true };
                }
                if (table.roles.title < 0) {
                    result.skipped.push({ line: lineNo, raw: ctx.raw, reason: 'table' });
                    continue;
                }
                const entries = parseTableRow(cells, table.roles, ctx);
                if (!entries.length) result.skipped.push({ line: lineNo, raw: ctx.raw, reason: 'empty' });
                pushAll(result, entries);
                continue;
            }
            table = null;

            // Headings, rules, setext underlines, fences.
            const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(trimmed);
            if (heading) {
                const title = stripMarkdown(heading[1]);
                result.currentSection = clip(title, MAX_TITLE);
                result.sections.push({ title: result.currentSection, line: lineNo, firstEntry: result.entries.length });
                seriesContext = title;
                seriesContextEntry = undefined;
                continue;
            }
            if (/^([-*_=]\s*){3,}$/.test(trimmed) || /^```/.test(trimmed)) continue;

            let body = trimmed.replace(/^>\s?/, '');
            const marker = /^(?:(\d{1,4})[.)]|[-*+•‣◦])\s+(.*)$/.exec(body);
            const listItem = !!marker;
            if (marker) body = marker[2];
            // Task-list checkboxes: "- [ ] Title" / "- [x] Title".
            body = body.replace(/^\[[ xX]\]\s+/, '');
            const plain = stripMarkdown(body);
            if (!plain) continue;

            // A list/chart URL on its own: that belongs in the URL import.
            const provider = listUrlProvider(plain);
            if (provider && /^\S+$/.test(plain.replace(/^<|>$/g, ''))) {
                result.skipped.push({ line: lineNo, raw: ctx.raw, reason: 'listUrl', provider });
                continue;
            }

            // Lone "Season 2" under a series title or heading.
            const loneSeason = /^seasons?\s+(\d{1,3})(?:\s*[-–—]\s*(\d{1,3}))?\b\s*(?:[—–:-]\s*(.*))?$/i.exec(plain);
            if (loneSeason && seriesContext) {
                if (seriesContextEntry !== undefined && result.entries[seriesContextEntry]?.title === seriesContext) {
                    // The bare series line only introduced its seasons.
                    result.entries.splice(seriesContextEntry, 1);
                    seriesContextEntry = undefined;
                }
                const from = Number(loneSeason[1]);
                const to = loneSeason[2] !== undefined ? Number(loneSeason[2]) : from;
                for (const season of seasonRange(from, to)) {
                    result.entries.push(makeEntry({ ...ctx, source: 'season', title: seriesContext, season, note: loneSeason[3] ? stripMarkdown(loneSeason[3]) : undefined }));
                }
                continue;
            }

            // → chains.
            if (/(→|⟶|➔|➜|\s->\s)/.test(body)) {
                const chain = parseChain(body, { ...ctx, allowSlash: true });
                if (chain) {
                    if (!chain.length) result.skipped.push({ line: lineNo, raw: ctx.raw, reason: 'prose' });
                    pushAll(result, chain);
                    continue;
                }
                result.skipped.push({ line: lineNo, raw: ctx.raw, reason: 'prose' });
                continue;
            }

            const isLinkItem = /^\[[^\]]+\]\(/.test(body);
            const hasIds = TMDB_URL.test(body) || IMDB_ID.test(body) || TMDB_PREFIX.test(body) || TVDB_PREFIX.test(body);
            if (!isLinkItem && !hasIds && looksLikeProse(plain.replace(/\s+·\s+.*$/, ''))) {
                result.skipped.push({ line: lineNo, raw: ctx.raw, reason: 'prose' });
                continue;
            }

            const alternatives = splitAlternatives(body, false);
            const entries = alternatives.length > 1
                ? withAlternatives(alternatives.map(alt => parseItem(alt, { ...ctx, source: listItem ? 'list' : 'plain' })), ctx)
                : parseItem(body, { ...ctx, source: isLinkItem || listItem ? 'list' : 'plain' });
            if (!entries.length) {
                result.skipped.push({ line: lineNo, raw: ctx.raw, reason: 'prose' });
                continue;
            }
            const startIndex = result.entries.length;
            pushAll(result, entries);
            const only = entries.length === 1 ? entries[0] : null;
            if (only && only.title && only.season === undefined && !only.episodes && !only.year && only.typeHint !== 'movie' && !listItem) {
                seriesContext = only.title;
                seriesContextEntry = startIndex;
            } else if (only && only.title) {
                seriesContext = only.title;
                seriesContextEntry = undefined;
            }
        }
    }

    /**
     * Appends entries to the result.
     * @param {object} result Parse result.
     * @param {object[]} entries Entries.
     */
    function pushAll(result, entries) {
        for (const entry of entries) {
            if (!entry || (!entry.title && !entry.ids)) continue;
            result.entries.push(entry);
        }
    }

    /**
     * Identity of an entry for duplicate flagging (type, ids/title, year, season, episodes).
     * @param {object} entry Entry.
     * @returns {string} Key.
     */
    function entryKey(entry) {
        // Titles compare by letters and digits of any script ("千と千尋の神隠し" and "メトロポリス" are different titles).
        const id = entry.ids?.tmdb ? `tmdb:${entry.ids.tmdbType || ''}:${entry.ids.tmdb}`
            : entry.ids?.imdb ? `imdb:${entry.ids.imdb}`
                : entry.ids?.tvdb ? `tvdb:${entry.ids.tvdb}`
                    : `t:${String(entry.title ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}`;
        const episodes = (entry.episodes || []).map(e => `${e.s}x${e.e}`).join(',');
        return [entry.typeHint || '', id, entry.year || '', entry.season ?? '', episodes, entry.episodeTitle || ''].join('|');
    }

    /**
     * Numbers entries, flags duplicates and fixes section indexes.
     * @param {object} result Parse result.
     */
    function finish(result) {
        const seen = new Map();
        result.entries.forEach((entry, index) => {
            entry.index = index;
            const key = entryKey(entry);
            if (seen.has(key)) entry.dupOf = seen.get(key);
            else seen.set(key, index);
        });
        result.sections = result.sections.filter((section, i, all) => i === all.length - 1 || all[i + 1].firstEntry > section.firstEntry || section.firstEntry < result.entries.length);
    }

    const parser = Object.freeze({
        parse,
        MAX_ENTRIES,
        // Exposed for tests and for the import review UI (re-parsing an edited row).
        internals: Object.freeze({ parseItem, parseChain, parseRelease, findEpisodeRef, splitSeasonSuffix, splitInstruction, stripMarkdown, typeFromWords, statusFromWords, parseCsv, detectCsv, looksLikeProse })
    });

    JE.internals = JE.internals || {};
    const lp = JE.internals.listPlaceholders = JE.internals.listPlaceholders || {};
    lp.parser = parser;
    JE.listPlaceholders = JE.listPlaceholders || {};
    JE.listPlaceholders.parser = parser;
})(window.JellyfinEnhanced);
