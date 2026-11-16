/**
 * @file Hidden tags on the Groups tab: each group row points to its tags in the colour editor's tag
 * list (Colours and text tab), where single tags are hidden for everyone, and says how many are hidden.
 */
import { find } from './dom';
import type { TextKit } from './fields';
import { fmt } from './format';
import type { Config } from './values';

/** The row's link to the group's tag list on the Colours tab (every group with tags there). */
export function hiddenLinkHtml(groups: readonly string[] | undefined, groupId: string, name: string, { esc }: TextKit): string {
    if (!groups?.includes(groupId)) return '';
    return `<a class="je-ta-link je-ta-crosslink" href="#" data-je-goto="colours" data-je-colours-group="${esc(groupId)}"><span class="je-ta-link-text">${esc(fmt('Hidden {group} tags (Colours and text)', { group: name }))}</span><span class="material-icons" aria-hidden="true">arrow_forward</span></a>`;
}

/**
 * Write a group row's summary, which says when its group hides tags for everyone, and name its link by
 * whether any are hidden.
 * @param summary - The group's own summary.
 * @param ageRatings - The ratings on the hidden age rating boards (the public configuration's TagHiddenAgeRatings).
 */
export function syncHiddenRow(row: HTMLElement, summary: string, config: Config, groupId: string, title: string, ageRatings: unknown): void {
    const lists: unknown = config.TagHiddenValues;
    const list: unknown = lists && typeof lists === 'object' ? Reflect.get(lists, groupId.charAt(0).toUpperCase() + groupId.slice(1)) ?? Reflect.get(lists, groupId) : null;
    const count = Array.isArray(list) ? list.length : 0;
    // Age tiles stand for every rating sharing their colour: count the ratings, as the editor says.
    const ages = groupId === 'ageRating' && Array.isArray(ageRatings) ? ageRatings.length : 0;
    const hidden = !count ? '' : ages ? fmt(' · {n} ratings hidden', { n: ages }) : fmt(' · {n} {n|tag|tags} hidden', { n: count });
    const sum = row.querySelector('.je-ta-grow-sum');
    if (sum) sum.textContent = summary + hidden;
    const link = find(row, '[data-je-colours-group] .je-ta-link-text');
    if (link) link.textContent = fmt(count ? 'Hidden {group} tags (Colours and text)' : 'Hide individual {group} tags (Colours and text)', { group: title });
}
