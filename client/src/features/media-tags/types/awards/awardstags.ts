import type { TagRuntimeBridge } from '../../host';
import { isRecord, type JsonRecord } from '../../pipeline/dto';
import type { TagCtx, TagSpec } from '../../pipeline/contract';
import { CAPTION_KEYS, CSS, LABELS, LOGOS, LOGO_FILES, NAMES, type AwardId } from './awards-data';

const IDS: AwardId[] = ['imdbTop250', 'certifiedFresh', 'oscar', 'emmy', 'letterboxdTop250'];
export interface AwardsTags {
    IDS: readonly AwardId[];
    LABELS: Readonly<Record<AwardId, string>>;
    resolve(facts: unknown): AwardFact[];
    chip(fact: AwardFact): HTMLElement;
    CSS: string;
}
/** A provider-confirmed award or chart place. */
export interface AwardFact { id: AwardId; rank: number | undefined; year: unknown }
/** @file Cached Awards/chart chips shared by posters and the settings preview. */
export function createAwardsTags(JE: TagRuntimeBridge) {
    /** Read cache or batch facts, accepting either DTO key casing. */
    function read(facts: JsonRecord, key: string): unknown { return facts[key] ?? facts[key.charAt(0).toUpperCase() + key.slice(1)]; }
    /** Resolve only provider-confirmed facts; settings switches may remove individual ribbons. */
    function resolve(facts: unknown): AwardFact[] {
        if (!isRecord(facts) || JE.pluginConfig?.AwardsTagsEnabled === false) return [];
        const out: AwardFact[] = [];
        const admin = JE.pluginConfig || {};
        const push = (id: AwardId, flag: boolean, rank?: unknown, year?: unknown) => {
            if (!flag) return;
            if (rank === undefined || rank === null) out.push({ id, rank: undefined, year });
            else if (typeof rank === 'number' && Number.isInteger(rank) && rank > 0 && rank <= 250) out.push({ id, rank, year });
        };
        const imdb = read(facts, 'imdbRank'), letterboxd = read(facts, 'letterboxdRank');
        push('imdbTop250', admin.AwardsTagsImdb !== false && imdb != null, imdb);
        push('certifiedFresh', admin.AwardsTagsCertifiedFresh !== false && read(facts, 'certifiedFresh') === true);
        push('oscar', admin.AwardsTagsOscar !== false && read(facts, 'oscarWinner') === true, undefined, read(facts, 'oscarYear'));
        push('emmy', admin.AwardsTagsEmmy !== false && read(facts, 'emmyWinner') === true, undefined, read(facts, 'emmyYear'));
        push('letterboxdTop250', admin.AwardsTagsLetterboxd !== false && letterboxd != null, letterboxd);
        return out;
    }
    /** Build an escaped text chip around trusted, bundled decorative logo artwork. */
    function chip(fact: AwardFact): HTMLElement {
        const el = document.createElement('div');
        el.className = 'awards-tag';
        el.dataset.jeAward = fact.id;
        const name = JE.t(NAMES[fact.id]);
        el.title = name + (fact.rank ? ' · ' + JE.t('awards_tags_rank', { rank: fact.rank }) : '') + (Number.isInteger(fact.year) ? ' · ' + fact.year : '');
        el.setAttribute('aria-label', el.title);
        const logo = document.createElement('span');
        logo.className = 'awards-tag-logo';
        logo.setAttribute('aria-hidden', 'true');
        const file = LOGO_FILES[fact.id];
        if (file && typeof JE.cdn?.url === 'function') {
            // The same artwork as the item-details rating row and the Awards banner, from the plugin's bundled assets.
            const img = document.createElement('img');
            img.src = JE.cdn.url(file[0], file[1]);
            img.alt = '';
            img.decoding = 'async';
            logo.appendChild(img);
        } else {
            logo.innerHTML = LOGOS[fact.id] || '';
        }
        const text = document.createElement('span');
        text.textContent = JE.t(CAPTION_KEYS[fact.id]);
        el.append(logo, text);
        return el;
    }
    /** Render already filtered facts through the shared placement and caps controller. */
    function render(ctx: TagCtx, el: HTMLElement, facts: unknown): void {
        if (ctx.shouldIgnore(el) || el.closest('.je-hidden')) return;
        ctx.removeExistingOverlay(el);
        const wrapper = document.createElement('div');
        wrapper.className = 'awards-overlay-container';
        for (const fact of resolve(facts)) wrapper.appendChild(chip(fact));
        ctx.commitOverlay(el, wrapper);
    }
    const spec: TagSpec = {
        logPrefix: '[AwardsTags]', settingKey: 'awardsTagsEnabled', containerClass: 'awards-overlay-container', taggedAttr: 'jeAwardsTagged',
        styleId: 'je-awards-tags-css', buildCss: () => CSS,
        position: { userKey: 'awardsTagsPosition', pluginKey: 'AwardsTagsPosition', fallback: 'top-left' },
        cache: { key: 'JellyfinEnhanced-awardsTagsCache', legacyPrefix: 'awardsTagsCache', hotBucket: 'awards', saveOnUnload: false },
        pipeline: {
            needsFirstEpisode: false, needsParentSeries: false,
            render(ctx: TagCtx, el, item) {
                ctx.setPersistent(String(item.Id), { facts: item.Awards || null });
                render(ctx, el, item.Awards);
            },
            renderFromCache(ctx: TagCtx, el, itemId) {
                const cached = ctx.hot?.get(itemId) ?? ctx.getPersistent(itemId);
                if (!isRecord(cached)) return false;
                render(ctx, el, cached.facts);
                return true;
            },
            renderFromServerCache(ctx: TagCtx, el, entry) { render(ctx, el, entry.Awards); },
        },
    };
    /** Register Awards when enabled; no upstream or per-card network lookups. */
    JE.initializeAwardsTags = function() { JE.core.tagRenderer.register('awards', spec).injectCss(); };
    /** Re-register and clear old chips after a personal switch changes. */
    JE.reinitializeAwardsTags = function() { JE.core.tagRenderer.reinitialize('awards', spec); };
    JE.awardsTags = { IDS, LABELS, resolve, chip, CSS };
    // Previews may enable this group while the signed-in user has it off.
    JE.core.tagRenderer.registerStyles(spec);
}
