/**
 * @file Media Tags admin tab, Status badges tab: which badge families new
 * users start with (each with the chip it shows), the two time windows
 * (server-wide), whether the TMDB key the schedule and trending badges
 * use is set, and the Leaving soon source (Maintainerr or collection names).
 */
/*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
 *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
 *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
 *  to the sections this module registers and to what those readers found in the JavaScript module.
const FAMILY_FIELDS = [
    { id: 'statusTagsJustAdded', key: 'StatusTagsJustAdded', type: 'switch', label: 'Just Added' },
    { id: 'statusTagsNewRelease', key: 'StatusTagsNewRelease', type: 'switch', label: 'New releases' },
    { id: 'statusTagsTrending', key: 'StatusTagsTrending', type: 'switch', label: 'Trending' },
    { id: 'statusTagsSchedule', key: 'StatusTagsSchedule', type: 'switch', label: 'Schedule' },
    { id: 'statusTagsMilestones', key: 'StatusTagsMilestones', type: 'switch', label: 'Milestones' },
    { id: 'statusTagsSeriesStatus', key: 'StatusTagsSeriesStatus', type: 'switch', label: 'Series status' },
    { id: 'statusTagsScenes', key: 'StatusTagsScenes', type: 'switch', label: 'Scenes' },
    { id: 'statusTagsLeaving', key: 'StatusTagsLeaving', type: 'switch', label: 'Leaving soon' },
    { id: 'statusTagsDirectPlay', key: 'StatusTagsDirectPlay', type: 'switch', label: 'Direct-play warning' },
];
registerSection({
    tab: 'badges',
    title: 'Badge families',
    fields: FAMILY_FIELDS,
registerSection({
    tab: 'badges',
    title: 'Collections',
        { id: 'statusTagsOnCollections', key: 'StatusTagsOnCollections', type: 'switch', label: 'Show status badges on collections' },
registerSection({
    tab: 'badges',
    title: 'Time windows',
        { id: 'statusTagsJustAddedDays', key: 'StatusTagsJustAddedDays', type: 'number', label: 'Just added' },
        { id: 'statusTagsNewReleaseDays', key: 'StatusTagsNewReleaseDays', type: 'number', label: 'New release' },
registerSection({
    tab: 'badges',
    title: 'TMDB API key',
registerSection({
    tab: 'badges',
    title: 'Leaving soon',
        { id: 'leavingSoonCollections', key: 'LeavingSoonCollections', type: 'textarea', label: 'Leaving collections' },
*/
import { optionalApiClient } from '../host';
import { find, findAs } from '../dom';
import type { FmtParams } from '../format';
import type { FieldDef, PageContext } from '../types';
import { own } from '../values';
import { installSection } from './install';

/** A sample chip: [kind, data-je-status, label key, label params?]. */
type Sample = readonly [string, string, string, FmtParams?];
/** Family switch id → the sample chip. */
const SAMPLES: Readonly<Record<string, Sample>> = {
    statusTagsJustAdded: ['added', 'added', 'Just Added'],
    statusTagsNewRelease: ['new', 'newMovie', 'New Movie'],
    statusTagsTrending: ['trending', 'trending', '#{rank} Today'],
    statusTagsSchedule: ['schedule', 'airing_today', 'Airing Today'],
    statusTagsMilestones: ['milestone', 'season_finale', 'Season Finale'],
    statusTagsSeriesStatus: ['status', 'returning', 'Returning'],
    statusTagsScenes: ['scenes', 'post_credits', 'Post-credits'],
    statusTagsLeaving: ['leaving', 'leaving', 'Leaving in {days}d', { days: 5 }],
    statusTagsDirectPlay: ['playback', 'direct_play', 'Transcode'],
};

const FAMILY_FIELDS: FieldDef[] = [
    { id: 'statusTagsJustAdded', key: 'StatusTagsJustAdded', type: 'switch', place: 'section', label: 'Just Added', desc: 'Recently added to a library' },
    { id: 'statusTagsNewRelease', key: 'StatusTagsNewRelease', type: 'switch', place: 'section', label: 'New releases', desc: 'New Movie / New Series / New Episode' },
    { id: 'statusTagsTrending', key: 'StatusTagsTrending', type: 'switch', place: 'section', label: 'Trending', desc: 'Rank in TMDB\'s daily trending list (needs the TMDB API key), or Seerr\'s weekly list without one. Off also stops the server fetching the list.' },
    { id: 'statusTagsSchedule', key: 'StatusTagsSchedule', type: 'switch', place: 'section', label: 'Schedule', desc: 'When a series’ next episode airs (needs the TMDB API key), and Coming Soon for movies and series that have not premiered yet.' },
    { id: 'statusTagsMilestones', key: 'StatusTagsMilestones', type: 'switch', place: 'section', label: 'Milestones', desc: 'Season milestones from the library’s episode dates; Season Finale and Series Finale need the TMDB API key.' },
    { id: 'statusTagsSeriesStatus', key: 'StatusTagsSeriesStatus', type: 'switch', place: 'section', label: 'Series status', desc: 'The series status, when no other badge applies. Jellyfin supplies Returning and Ended; TMDB can refine Ended to Cancelled. Off by default.' },
    { id: 'statusTagsScenes', key: 'StatusTagsScenes', type: 'switch', place: 'section', label: 'Scenes', desc: 'Show a movie’s post-credits or mid-credits marker from TMDB keywords. Requires a TMDB key; refreshed daily.' },
    { id: 'statusTagsLeaving', key: 'StatusTagsLeaving', type: 'switch', place: 'section', label: 'Leaving soon', desc: 'Items in Maintainerr\'s collections or the leaving collections (set the source under Leaving soon).' },
    { id: 'statusTagsDirectPlay', key: 'StatusTagsDirectPlay', type: 'switch', place: 'section', label: 'Direct-play warning', desc: 'Each browser checks the movies and episodes on screen against its own playback support (web only; native posters have no client profile). Items Jellyfin would probe to answer, .strm items and media never probed, are skipped.' },
];

/** GET admin/leaving-soon, as far as the card reads it. */
interface LeavingStatus {
    LastError: unknown; LastSuccess: unknown; NextRefresh: unknown;
    Collections: unknown; CollectionsFound: unknown; Items: unknown; Dated: unknown;
    Actions: unknown; HomeRow: unknown;
}
interface LeavingState { status: LeavingStatus | null; busy: boolean }

/** The status answer when it is an object. */
function statusOfAnswer(value: unknown): LeavingStatus | null {
    if (!value || typeof value !== 'object') return null;
    const read = (key: string): unknown => Reflect.get(value, key);
    return {
        LastError: read('LastError'), LastSuccess: read('LastSuccess'), NextRefresh: read('NextRefresh'),
        Collections: read('Collections'), CollectionsFound: read('CollectionsFound'), Items: read('Items'), Dated: read('Dated'),
        Actions: read('Actions'), HomeRow: read('HomeRow'),
    };
}

/** What the server says about the Home Screen Sections row (LeavingSoonStatus.HomeRow). */
const HOME_ROW_STATES: Readonly<Record<string, string>> = {
    registered: 'Home row: registered with Home Screen Sections.',
    'hss-missing': 'Home row: Home Screen Sections is not installed, so there is no row.',
    'ft-missing': 'Home row: registered, but File Transformation is not installed, so Home Screen Sections cannot draw it.',
    failed: 'Home row: registration failed (see the plugin log).',
    off: 'Home row: off.',
    unknown: 'Home row: waiting for Home Screen Sections to load.',
};

/** Each state line by its text: on when up to date, off without a source, else a warning. */
const LEAVING_STATES: Readonly<Record<string, 'on' | 'off'>> = { 'Up to date': 'on', 'No source set': 'off' };

/**
 * The state line's text key and its chip state for a Leaving soon status.
 * @param configured - A source (Maintainerr URL or collection names) is set.
 * @param s - The last status answer.
 * @returns {{key: string, state: string}}
 */
export function leavingState(configured: boolean, s: LeavingStatus | null): { key: string; state: 'on' | 'off' | 'warn' } {
    const key = !configured ? 'No source set' : !s ? 'Status unavailable' : s.LastError ? 'Last refresh failed: {error}' : s.LastSuccess ? 'Up to date' : 'Not read yet';
    return { key, state: own(LEAVING_STATES, key) ?? 'warn' };
}

const numberOr = (value: unknown, fallback: number): string | number => (typeof value === 'number' || typeof value === 'string' ? value : value === null || value === undefined ? fallback : String(value));

installSection((A, JE) => {
    /** A sample chip for a family (the page's own chip style: the status module's stylesheet only reaches chips on cards). */
    function chipHtml(ctx: PageContext, sample: Sample | undefined): string {
        if (!sample) return '';
        const [kind, status, labelKey, params] = sample;
        const label = kind === 'trending' ? A.fmt(labelKey, { rank: 1 }) : A.fmt(labelKey, params);
        return `<span class="je-ta-chip" data-kind="status" data-je-status="${status}">${ctx.esc(label)}</span>`;
    }

    /**
     * Each view's Leaving soon state: its last status answer (GET admin/leaving-soon)
     * and whether its status request or refresh is running. Per view, so a view
     * Jellyfin builds while another one's request is on its way asks for itself,
     * and a disposed view's late answer only ever reaches that view.
     */
    const leavingStates = new WeakMap<PageContext, LeavingState>();
    function leavingOf(ctx: PageContext): LeavingState {
        let state = leavingStates.get(ctx);
        if (!state) leavingStates.set(ctx, state = { status: null, busy: false });
        return state;
    }

    /** A time as Jellyfin Enhanced's interface language writes it (core/media-language.js), or a dash. */
    function when(ms: unknown): string {
        if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
        try { return new Date(ms).toLocaleString(JE.core?.mediaLanguage?.uiLocale?.() || undefined); } catch { return new Date(ms).toISOString(); }
    }

    /**
     * Ask the server for the Leaving soon state (or read the source again first: POST admin/leaving-soon/refresh), then
     * redraw. The source itself is set on the Services tab, so there are no unsaved edits on this page to flush first.
     */
    async function loadLeavingStatus(ctx: PageContext, refresh: boolean): Promise<void> {
        const leaving = leavingOf(ctx);
        const client = optionalApiClient();
        if (leaving.busy || !client) return;
        leaving.busy = true;
        const button = findAs(ctx.root, '#leavingSoonRefreshBtn', HTMLButtonElement);
        if (button) button.disabled = true;
        try {
            const answer = await client.ajax({
                type: refresh ? 'POST' : 'GET',
                url: client.getUrl(refresh ? 'JellyfinEnhanced/admin/leaving-soon/refresh' : 'JellyfinEnhanced/admin/leaving-soon'),
                dataType: 'json',
            });
            if (!ctx.isCurrent()) return;
            leaving.status = statusOfAnswer(answer);
            if (refresh) ctx.snack(A.fmt(leaving.status?.LastError ? 'Leaving soon refresh failed' : 'Leaving soon refreshed'));
        } catch {
            if (!ctx.isCurrent()) return;
            leaving.status = null;
            if (refresh) ctx.snack(A.fmt('Leaving soon refresh failed'));
        } finally {
            leaving.busy = false;
            if (ctx.isCurrent()) ctx.refresh({ controls: false });
        }
    }

    A.registerSection({
        id: 'badges-families',
        tab: 'badges',
        order: 10,
        title: 'Badge families',
        hint: 'One badge per poster, first match wins (the order per card type is in the documentation). Users can override the family switches in their personal settings; the day windows apply to everyone.',
        fields: FAMILY_FIELDS,
        render(ctx, body) {
            body.innerHTML = `<p class="je-ta-off" data-badges-off>${ctx.tx('Status tags are off for new users, so none of these show.')} <a class="je-ta-link" href="#" data-je-goto="groups:status">${ctx.tx('Turn Status on')}</a></p>`
                + `<div class="je-ta-badges">${FAMILY_FIELDS.map((f) => `<div class="je-ta-badge">${A.fieldHtml(f, ctx.config)}<span class="je-ta-badge-sample" aria-hidden="true">${chipHtml(ctx, own(SAMPLES, f.id))}</span></div>`).join('')}</div>`;
        },
        refresh(ctx, body) {
            const off = find(body, '[data-badges-off]');
            if (off) off.hidden = ctx.config.StatusTagsEnabled === true;
        },
    });

    A.registerSection({
        id: 'badges-collections',
        tab: 'badges',
        order: 15,
        title: 'Collections',
        hint: 'This applies to everyone.',
        fields: [
            { id: 'statusTagsOnCollections', key: 'StatusTagsOnCollections', type: 'switch', label: 'Show status badges on collections', desc: 'A collection shows Just Added when something in it was added recently. Turn this off to keep status badges off collections.' },
        ],
    });

    A.registerSection({
        id: 'badges-windows',
        tab: 'badges',
        order: 20,
        title: 'Time windows',
        hint: 'These apply to everyone.',
        fields: [
            { id: 'statusTagsJustAddedDays', key: 'StatusTagsJustAddedDays', type: 'number', min: 1, max: 365, fallback: 7, unit: 'days', label: 'Just added', desc: 'An item counts as just added (and a series or season shows New Episode) for this many days after it reached the library.', read: (v) => Number(v) || 7 },
            { id: 'statusTagsNewReleaseDays', key: 'StatusTagsNewReleaseDays', type: 'number', min: 1, max: 365, fallback: 30, unit: 'days', label: 'New release', desc: 'A movie or series counts as new for this many days after its premiere.', read: (v) => Number(v) || 30 },
        ],
    });

    A.registerSection({
        id: 'badges-tmdb',
        tab: 'badges',
        order: 30,
        title: 'TMDB API key',
        render(ctx, body) {
            body.innerHTML = '<div class="je-ta-state-row"><span class="je-ta-state" data-tmdb-state></span></div>'
                + `<p class="je-ta-hint">${ctx.tx('Daily popular ranks, next air dates and season and series finales use the TMDB API key. Without it, trending can use Seerr\'s weekly list.')}</p>`
                + `<a class="je-ta-link" href="${ctx.esc(ctx.mainPageUrl(null, 'services'))}"><span class="je-ta-link-text">${ctx.tx('TMDB API key setting')}</span><span class="material-icons" aria-hidden="true">open_in_new</span></a>`;
        },
        refresh(ctx, body) {
            // Updated in place: every refresh (a save, the library list) would otherwise replace a focused link.
            const state = find(body, '[data-tmdb-state]');
            if (!state) return;
            const set = String(ctx.config.TMDB_API_KEY || '').trim() !== '';
            state.dataset.state = set ? 'on' : 'warn';
            state.textContent = A.fmt(set ? 'Set' : 'Not set');
        },
    });

    A.registerSection({
        id: 'badges-leaving',
        tab: 'badges',
        order: 40,
        title: 'Leaving soon',
        hint: 'Where the Leaving soon badge comes from: Maintainerr\'s collections (with the day each item goes), or existing Jellyfin collections by name (no date). Maintainerr\'s address, key, item-menu actions and home row are set in the *arr tab (also under Services).',
        fields: [
            { id: 'leavingSoonCollections', key: 'LeavingSoonCollections', type: 'textarea', rows: 3, placeholder: 'Leaving Soon', label: 'Leaving collections', desc: 'Existing Jellyfin collection names, one per line, whose items count as leaving soon, without a date. For setups that do not use Maintainerr\'s address; nothing is created. Up to 20.' },
        ],
        render(ctx, body) {
            body.innerHTML = '<div class="je-ta-state-row"><span class="je-ta-state" data-leaving-state></span></div>'
                + '<p class="je-ta-hint" data-leaving-detail></p>'
                + '<p class="je-ta-hint" data-leaving-row></p>'
                + `<div class="je-ta-actions"><button type="button" class="je-ta-button" id="leavingSoonRefreshBtn"><span class="material-icons" aria-hidden="true">refresh</span>${ctx.tx('Refresh now')}</button></div>`
                + `<p class="je-ta-hint">${ctx.tx('Cards never ask Maintainerr: the server reads it on a schedule and keeps the answer in the tag cache.')}</p>`
                + `<a class="je-ta-link" href="${ctx.esc(ctx.mainPageUrl(null, 'arr'))}"><span class="je-ta-link-text">${ctx.tx('Maintainerr settings')}</span><span class="material-icons" aria-hidden="true">open_in_new</span></a>`;
            body.querySelector('#leavingSoonRefreshBtn')?.addEventListener('click', () => { void loadLeavingStatus(ctx, true); });
            void loadLeavingStatus(ctx, false);
        },
        refresh(ctx, body) {
            if (!body) return;
            const state = find(body, '[data-leaving-state]');
            const detail = body.querySelector('[data-leaving-detail]');
            const row = body.querySelector('[data-leaving-row]');
            const button = findAs(body, '#leavingSoonRefreshBtn', HTMLButtonElement);
            const { status: s, busy } = leavingOf(ctx);
            const maintainerr = String(ctx.config.LeavingSoonMaintainerrUrl || '').trim() !== '';
            const configured = maintainerr || String(ctx.config.LeavingSoonCollections || '').trim() !== '';
            if (button) button.disabled = busy || !configured;
            if (!state || !detail) return;
            const shown = leavingState(configured, s);
            state.dataset.state = shown.state;
            state.textContent = A.fmt(shown.key, { error: s?.LastError ? String(s.LastError) : '' });
            const collections = s?.Collections ? ` · ${A.fmt('{found} of {names} collections found', { found: numberOr(s.CollectionsFound, 0), names: numberOr(s.Collections, 0) })}` : '';
            detail.textContent = configured && s ? A.fmt('{items} {items|item|items} leaving ({dated} with a date) · last read {last} · next {next}', {
                items: numberOr(s.Items, 0), dated: numberOr(s.Dated, 0), last: when(s.LastSuccess), next: when(s.NextRefresh),
            }) + collections : '';
            if (row) row.textContent = !maintainerr || !s ? '' : [A.fmt(s.Actions === true ? 'Item-menu actions: on.' : 'Item-menu actions: off.'), A.fmt(own(HOME_ROW_STATES, String(s.HomeRow)) ?? HOME_ROW_STATES.unknown ?? '')].filter(Boolean).join(' ');
        },
    });
});
