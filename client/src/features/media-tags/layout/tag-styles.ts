import { apiClient, type TagRuntimeBridge } from '../host';
import { isRecord, record, records, type JsonRecord } from '../pipeline/dto';

export interface TagStyles {
    PRESETS: readonly string[];
    SCOPE_ATTR: string;
    buildCss(styles: unknown, scope?: string | null): string;
    deactivate(): void;
}
// /js/tags/tag-styles.js
// Applies Tag Styles (Configuration > Tag Styles) to the web overlays. The
// server resolves every chip's colours (preset palette, then group override,
// then label override) and only hands them out when the admin's target is
// "web" or "both"; the same resolution drives the poster images drawn for
// native clients, so both stay in step. When the admin lets users pick their
// own preset, the user's choice (settings panel) is sent along and the admin's
// group and label overrides stay on top. Rules use a doubled/extra class so
// they beat the tag modules' own rules whatever order the stylesheets land in.
// Under the Poster preset the server lists only the overrides; the colours
// underneath come from each card's artwork (tags/tag-poster-colours.js), set
// as custom properties on the card, and posterRules() below paints them: each
// rule matches its group's override selectors in specificity and comes first,
// so a tag or group colour the admin set wins field by field.
export function createTagStyles(JE: TagRuntimeBridge) {

    const logPrefix = '🪼 Jellyfin Enhanced: Tag Styles:';
    const styleId = 'je-tag-style-overrides';
    const PRESETS = ['default', 'glass', 'outline', 'dark', 'light', 'mono', 'poster'];
    // A status badge id is a plain word (the data-je-status values); anything else never reaches the stylesheet.
    const STATUS_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

    // Values come from the server already validated as rgba() colours; this is
    // a second guard so nothing but a colour can ever reach the stylesheet.
    const COLOUR = /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*[\d.]+\s*\)$/;
    const decl = (prop: string, value: unknown) => (typeof value === 'string' && COLOUR.test(value) ? `${prop}: ${value} !important;` : '');
    /** Escapes a value for a double-quoted CSS attribute selector. */
    const attr = (value: unknown) => String(value).replace(/["\\]/g, '\\$&').replace(/[\n\r\f]/g, '\\a ');

    let requestSeq = 0;
    let listening = false;

    /**
     * Background, text and border declarations for a chip that has a border.
     * */
    function box(c: JsonRecord): string {
        return decl('background-color', c.background) + decl('color', c.color) + decl('border-color', c.border);
    }

    /**
     * Declarations for a chip without a border of its own (rating chips, flags):
     * the Tag Styles border is an inner 1px ring, so the chip keeps its size
     * and native posters draw the same pixels.
     * */
    function ring(border: unknown): string {
        return typeof border === 'string' && COLOUR.test(border) ? `outline: 1px solid ${border} !important; outline-offset: -1px !important; --je-tag-ring-color: ${border} !important; outline-color: var(--je-tag-ring-outline, ${border}) !important;` : '';
    }

    /**
     * Pushes `selector { body }` when the body is not empty.
     * */
    // One element id, as `#tagStylePreview`: no combinators, lists or braces.
    const SCOPE_ID = /^#[A-Za-z_][A-Za-z0-9_-]*$/;
    // Page-wide rules leave out chips inside an element with this attribute:
    // a preview that draws other styles with its own scoped sheet (the Media
    // Tags admin page draws the server defaults, not the signed-in user's).
    // :where() adds no specificity, so every other chip matches as before.
    const SCOPE_ATTR = 'data-je-tag-styles-scope';
    const OUTSIDE_SCOPES = `:where(:not([${SCOPE_ATTR}] *))`;

    function push(rules: string[], selector: string, body: string): void {
        if (body) rules.push(`${selector} { ${body} }`);
    }

    // A genre name that floats beside its chip on hover, not one written
    // inline in the hover reveal (which keeps the chip's own background).
    const GENRE_NAME_FLOATS = ':not([data-je-slot="hover"] *)';

    /**
     * The genre colours keyed by label: `*` (every genre chip), then the
     * canonical genres (data-je-genre). An older single colour object counts
     * as `*`.
     * */
    function genreMap(genre: unknown): JsonRecord {
        if (!isRecord(genre)) return {};
        return ['background', 'border', 'color'].some((f) => typeof genre[f] === 'string') ? { '*': genre } : genre;
    }

    /**
     * The Poster preset's static rules: chips on a card marked
     * data-je-poster-colour take its --je-tag-bg / --je-tag-border /
     * --je-tag-fg. Each selector has the specificity of the override rules
     * of its group (buildCss), so those, coming later, win field by field;
     * !important beats the tag modules' own colours. Flags keep theirs.
     * @param P - Scope prefix ('' or '#id ').
     * @param [groups] - The groups under the Poster preset (all of them when omitted).
     * */
    function posterRules(P: string, groups?: readonly unknown[]): string[] {
        const M = `${P}[data-je-poster-colour]`;
        const fill = 'background: var(--je-tag-bg) !important; color: var(--je-tag-fg) !important;';
        const edge = 'border-color: var(--je-tag-border) !important;';
        const ringed = 'outline: 1px solid var(--je-tag-border) !important; outline-offset: -1px !important; --je-tag-ring-color: var(--je-tag-border) !important; outline-color: var(--je-tag-ring-outline, var(--je-tag-border)) !important;';
        const all = !groups;
        const on = (g: string) => all || groups.includes(g);
        const table: ReadonlyArray<readonly [string, string]> = [
            // (0,4,0): over the quality module's !important label rules, level with the "*" override.
            ['quality', `${M} .quality-overlay-container.quality-overlay-container .quality-overlay-label { ${fill} ${edge} }`],
            ['ageRating', `${M} .age-rating-overlay-container .age-rating-tag { background-color: var(--je-tag-bg) !important; color: var(--je-tag-fg) !important; ${edge} }`],
            ['rating', `${M} .rating-overlay-container .rating-tag { ${fill} ${ringed} }`],
            ['rating', `${M} .rating-overlay-container .rating-tag :is(.rating-star-icon, .je-userreview-icon) { color: var(--je-tag-fg) !important; }`],
            ['awards', `${M} .awards-overlay-container .awards-tag { ${fill} ${ringed} }`],
            ['logos', `${M} .logo-overlay-container .je-logo-chip[data-je-logo-style] { ${fill} ${edge} }`],
            ['custom', `${M} .custom-overlay-container.custom-overlay-container .custom-tag { ${fill} ${edge} }`],
            ['genre', `${M} .genre-tag { background-color: var(--je-tag-bg) !important; color: var(--je-tag-fg) !important; ${edge} }`],
            ['language', `${M} .language-overlay-container .language-chip { ${fill} ${edge} }`],
            ['status', `${M} .status-overlay-container .status-tag { background-color: var(--je-tag-bg) !important; color: var(--je-tag-fg) !important; ${edge} }`],
            ['status', `${M} .status-overlay-container .status-tag .status-tag-rank { color: var(--je-tag-fg) !important; }`],
        ];
        const byGroup = table.filter(([g]) => on(g)).map(([, rule]) => rule);
        // The "+N" pill belongs to no group: it follows the preset for the whole design only.
        return all ? [
            ...byGroup,
            `${M} .je-tag-pill { background: var(--je-tag-bg); border-color: var(--je-tag-border); color: var(--je-tag-fg); }`,
            `${M} .je-tag-pill .je-tag-pill-glyph { color: inherit; }`,
        ] : byGroup;
    }

    /**
     * The groups the server model puts under the Poster preset (all of them when the whole design is).
     * @param styles - The server's web model.
     * @returns null when the whole design is Poster, [] when none is.
     */
    function posterGroupsOf(styles: JsonRecord): readonly unknown[] | null {
        if (styles.preset === 'poster') return null;
        return Array.isArray(styles.posterGroups) ? styles.posterGroups : [];
    }

    /**
     * Builds the stylesheet from the server's web model (GET tag-styles).
     * @param styles - `{quality, age, ageDefault, rating, genre, status, language, awards, logos, custom}`
     *   (`genre` is keyed by label like `quality`: `*`, then canonical genres).
     * @param [scope] - The id selector of one element every rule is
     *   limited to (`#tagStylePreview` for the config page's live preview);
     *   omitted, the rules style the whole page. Anything but a single `#id`
     *   is refused, so a caller can never widen the rules to other elements.
     *   Unscoped rules skip chips inside `[data-je-tag-styles-scope]`.
     * @returns The CSS, empty when nothing is styled.
     */
    function buildCss(input: unknown, scope?: string | null): string {
        const styles = record(input);
        const rules: string[] = [];
        if (scope !== undefined && scope !== null && scope !== '' && !SCOPE_ID.test(scope)) {
            throw new Error('tag-styles: scope must be a single #id selector');
        }
        const P = scope ? `${scope} ` : '';
        /**
         * Pushes one rule for these selectors (the page-wide sheet guards each one's subject).
         */
        const add = (selectors: string | readonly string[], body: string) => push(rules, (typeof selectors === 'string' ? [selectors] : selectors).map((sel) => (scope ? sel : sel + OUTSIDE_SCOPES)).join(', '), body);
        // Poster preset: the artwork's colours first, every override after them.
        const posterGroups = posterGroupsOf(styles);
        if (!posterGroups || posterGroups.length) rules.push(...posterRules(P, posterGroups || undefined).map((rule) => scope ? rule : rule.replace(/ (\{)/, OUTSIDE_SCOPES + ' $1')));
        const quality = record(styles.quality);
        const allQuality = record(quality['*']);
        // Beat category rules (including editions) regardless of reinjection order.
        const Q = `${P}.quality-overlay-container.quality-overlay-container.quality-overlay-container .quality-overlay-label`;
        // The "*" rule covers labels outside the catalog; per-label rules win on specificity.
        add(Q, `${decl('background', allQuality.background)}${decl('color', allQuality.color)}${decl('border-color', allQuality.border)}`);
        for (const [label, c] of Object.entries(quality)) {
            if (label === '*' || !isRecord(c)) continue;
            add(`${Q}[data-quality="${attr(label)}"]`, `${decl('background', c.background)}${decl('color', c.color)}${decl('border-color', c.border)}`);
        }

        const A = `${P}.age-rating-overlay-container .age-rating-tag`;
        add(`${P}.age-rating-overlay-container.age-rating-overlay-container .age-rating-tag`, box(record(styles.ageDefault)));
        for (const board of records(styles.age)) {
            const ratings: unknown[] = Array.isArray(board.ratings) ? board.ratings : [];
            if (!ratings.length) continue;
            add(ratings.map((r) => `${A}[rating="${attr(r)}"]`), box(board));
        }

        const chips = record(styles.rating);
        const R = `${P}.rating-overlay-container .rating-tag`;
        const community = record(chips.community);
        const critic = record(chips.critic);
        const userReview = record(chips.userReview);
        add(`${R}.rating-tag-tmdb`, decl('background', community.background) + decl('color', community.color) + ring(community.border));
        add(`${R}.rating-tag-tmdb .rating-star-icon`, decl('color', community.color));
        add(`${R}.rating-tag-critic`, decl('background', critic.background) + decl('color', critic.color) + ring(critic.border));
        add(`${R}.rating-tag-userreview`, decl('background', userReview.background) + decl('color', userReview.color) + ring(userReview.border));
        add(`${R}.rating-tag-userreview .je-userreview-icon`, decl('color', userReview.color));

        for (const [id, c] of Object.entries(chips)) {
            if (!isRecord(c) || ['community', 'critic', 'userReview'].includes(id)) continue;
            add(`${R}[data-je-rating-source="${attr(id)}"]`, decl('background', c.background) + decl('color', c.color) + ring(c.border));
        }

        // Genre: "*" is every chip, then each genre label (data-je-genre). Only a
        // genre with colours of its own colours its name (hover float, caption
        // strip, Summary/Minimal reveal): group and preset colours leave the
        // names as they always were, so existing documents draw unchanged.
        const genre = genreMap(styles.genre);
        const G = `${P}.genre-overlay-container .genre-tag`;
        add(G, box(record(genre['*'])));
        for (const [label, c] of Object.entries(genre)) {
            if (label === '*' || !isRecord(c)) continue;
            const L = `[data-je-genre="${attr(label)}"]`;
            add(`${G}${L}`, box(c));
            // Under Poster the name first takes the artwork colours its chip
            // has (same specificity as the rules below, which win field by field).
            if (!posterGroups || posterGroups.includes('genre')) {
                add(`${P}[data-je-poster-colour] .genre-tag${L} .genre-text`, 'color: var(--je-tag-fg) !important;');
                add(`${P}[data-je-poster-colour] .genre-tag${L} .genre-text${GENRE_NAME_FLOATS}`, 'background-color: var(--je-tag-bg) !important;');
            }
            add(`${G}${L} .genre-text`, decl('color', c.color));
            add(`${G}${L} .genre-text${GENRE_NAME_FLOATS}`, decl('background-color', c.background));
        }

        for (const [id, color] of Object.entries(record(styles.awards))) {
            if (isRecord(color)) add(`${P}.awards-overlay-container .awards-tag[data-je-award="${attr(id)}"]`, decl('background', color.background) + decl('color', color.color) + ring(color.border));
        }

        const status = record(styles.status);
        for (const key of Object.keys(status)) {
            const c = status[key];
            if (!isRecord(c) || !STATUS_KEY.test(key)) continue;
            const S = `${P}.status-overlay-container .status-tag[data-je-status="${key}"]`;
            add(S, box(c));
            // The rank ("#3") keeps its accent unless the text colour is styled.
            if (key === 'trending') add(`${S} .status-tag-rank`, decl('color', c.color));
        }

        // Custom chips: "*" is every chip of the group, then each rule label.
        const custom = record(styles.custom);
        const C = `${P}.custom-overlay-container.custom-overlay-container .custom-tag`;
        add(C, box(record(custom['*'])));
        for (const [label, c] of Object.entries(custom)) {
            if (label === '*' || !isRecord(c)) continue;
            add(`${C}[data-je-custom="${attr(label)}"]`, box(c));
        }

        add(`${P}.language-overlay-container .language-chip`, box(record(styles.language)));
        // Only flag images keep their inner ring; chip borders use the shared box treatment.
        const languageLabels = record(styles.languageLabels);
        const flagColours = record(languageLabels.flag || styles.language);
        add(`${P}.language-overlay-container .language-flag:not(.language-flag-partial)`, ring(flagColours.border));
        for (const [label, color] of Object.entries(languageLabels)) {
            if (!isRecord(color)) continue;
            if (['subtitles', 'countBadge', 'code'].includes(label)) {
                const kind = label === 'code' ? '.language-code' : `[data-je-language="${label}"]`;
                add(`${P}.language-overlay-container.language-overlay-container .language-chip${kind}`, box(color));
            } else if (label !== 'flag') {
                add(`${P}.language-overlay-container.language-overlay-container.language-overlay-container .language-chip[data-je-language-label="${attr(label)}"]`, box(color));
            }
        }
        // Logos: the pill behind a logo or name; text colours the name chip.
        const logos = record(styles.logos);
        for (const key of ['provider', 'company', 'text']) {
            const c = logos[key];
            if (isRecord(c)) add(`${P}.logo-overlay-container .je-logo-chip[data-je-logo-style="${key}"]`, box(c));
        }
        const flushStyles = JE.core?.tagLayout?.buildFlushStyles;
        if (scope && rules.length && flushStyles) rules.push(flushStyles(scope));
        return rules.join('\n');
    }

    /**
     * The preset to request: the user's own pick when the admin allows it.
     * */
    function userPreset(): string|null {
        if (!JE.pluginConfig?.TagStylesAllowUserPreset) return null;
        const preset = JE.currentSettings?.tagStylePreset;
        return typeof preset === 'string' && PRESETS.includes(preset) ? preset : null;
    }

    /**
     * Removes the stylesheet and invalidates every request in flight, so a
     * slower answer cannot bring the styles back. Synchronous on purpose.
     * */
    function deactivate(): void {
        requestSeq++;
        JE.core?.ui?.removeCss(styleId);
        JE.tagPosterColours?.setActive(false);
    }

    // On a user switch or logout the previous user's styles (their preset) go
    // at once; je:user-data-loaded re-applies them for the incoming user.
    JE.session?.onUserChange('tag-styles', deactivate);

    /**
     * Fetches the effective styles and (re)injects the stylesheet. Overlapping
     * calls (a quick preset change, a user switch) keep only the latest answer,
     * and an answer is dropped once the styles were deactivated or the
     * signed-in user changed while it was on its way.
     * */
    async function initializeTagStyles(): Promise<void> {
        if (!listening) {
            listening = true;
            // The incoming user's settings (and preset) are loaded by then.
            document.addEventListener('je:user-data-loaded', () => {
                if (JE.pluginConfig?.TagStyleWebActive) void initializeTagStyles();
                else deactivate();
            });
        }
        if (!JE.pluginConfig?.TagStyleWebActive) {
            deactivate();
            return;
        }
        const seq = ++requestSeq;
        const epoch = JE.session ? JE.session.getEpoch() : 0;
        try {
            const preset = userPreset();
            const styles = await apiClient().ajax({
                type: 'GET',
                url: apiClient().getUrl('JellyfinEnhanced/tag-styles', preset ? { preset } : undefined),
                dataType: 'json'
            });
            if (seq !== requestSeq || (JE.session && !JE.session.isCurrent(epoch)) || !JE.pluginConfig?.TagStyleWebActive) return;
            const css = buildCss(styles);
            if (css) JE.core.ui.injectCss(styleId, css);
            else JE.core.ui.removeCss(styleId);
            // Poster preset: cards take their artwork's colours from here on.
            const posterGroups = posterGroupsOf(record(styles));
            JE.tagPosterColours?.setActive(!posterGroups || posterGroups.length > 0);
        } catch (e) {
            console.warn(`${logPrefix} Could not load tag style overrides.`, e);
        }
    }
    JE.initializeTagStyles = initializeTagStyles;

    JE.tagStyles = { PRESETS, SCOPE_ATTR, buildCss, deactivate };
}
