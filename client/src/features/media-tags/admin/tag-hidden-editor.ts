/**
 * @file Hidden tags in the Tag Styles editor (Colours tab): each tile of the tag list can be hidden, so
 * its chips never draw, on web posters and native posters, for every user. The lists live in
 * TagHiddenValues ({ Genre: ['drama'], … }), kept by the Colours section through the store the editor
 * is given. The editor (tag-styles-editor.ts) owns what is picked and drawn; this module owns the
 * lists, the Hide switch, the hidden line and marks, and the words for what a tile hides.
 *
 * Tag text sits with it: a tile of a group whose chips are plain words (quality, genre, status, awards)
 * can show other words than its own ("Season Finale" -> "End of Season"). The texts live in
 * TagTextOverrides ({ status: { seasonFinale: 'End of Season' } }), kept by the Colours section too.
 */
import { find } from './dom';
import { fmt } from './format';
import type { AgeBoard, Label } from './tag-styles-model';
import { ALL, el, GROUPS } from './tag-styles-parts';
import type { HiddenStore, TextStore } from './types';

const T = fmt;
// Flag and Language codes colour every flag or code, so they are not tags to hide.
const NOT_HIDEABLE: Readonly<Record<string, readonly string[]>> = { language: ['flag', 'code'] };
// Only groups whose chips are plain words take a text.
const TEXT_GROUPS = ['quality', 'genre', 'status', 'awards'];
const pascal = (g: string): string => g.charAt(0).toUpperCase() + g.slice(1);
// A rating keeps its hyphen on one line ("TV-14", never "TV-" / "14").
const nb = (text: string): string => text.replace(/-/g, '‑');
const hiddenIcon = (cls = 'material-icons'): HTMLElement => {
    const icon = el('i', cls, 'visibility_off');
    icon.setAttribute('aria-hidden', 'true');
    return icon;
};

/** What the Hidden tags controls read from, and ask of, the editor they sit in. */
export interface HiddenEditorHost {
    root: HTMLElement;
    store: HiddenStore | null;
    texts: TextStore | null;
    /** The catalog's age rating boards (empty before the catalog is in). */
    ages(): readonly AgeBoard[];
    /** The Custom rules' labels, without the hidden labels whose rule is gone. */
    customLabels(): string[];
    labelsOf(group: string): Label[];
    current(): string;
    target(): string;
    hiddenOnly(): boolean;
    setHiddenOnly(on: boolean): void;
    /** Pick a tag of the open group (ALL: the whole group) and redraw the group. */
    pick(target: string): void;
    /** Open a group with its tag list on a tag, and redraw it once the catalog is in. */
    open(group: string, target: string): void;
    rebuildKeepingFocus(box: Element, build: () => void): void;
    renderTabs(): void;
    renderTargets(): void;
    renderGroup(): void;
    renderSample(): void;
    renderPreview(): void;
}

export function createHiddenTags(h: HiddenEditorHost) {
    const { root, store, texts } = h;
    const ratingsOf = (board: string): string[] => h.ages().find((a) => a.id === board)?.ratings || [];
    const hideable = (g: string, l: string): boolean => !!store && l !== ALL && !(NOT_HIDEABLE[g] || []).includes(l);
    /** The group's hidden labels. */
    function list(g: string): string[] {
        const doc: unknown = store?.get();
        if (!doc || typeof doc !== 'object') return [];
        const value: unknown = Reflect.get(doc, pascal(g)) ?? Reflect.get(doc, g);
        return Array.isArray(value) ? value.map(String) : [];
    }
    const isHidden = (g: string, l: string): boolean => list(g).includes(l);
    /** Whether a tile is hidden by another (Dual · Multi covers Dual and Multi). */
    const coveredBy = (g: string, l: string): boolean => g === 'language' && (l === 'dual' || l === 'multi') && isHidden('language', 'countBadge');
    const shownHidden = (g: string, l: string): boolean => isHidden(g, l) || coveredBy(g, l);
    /** How many of a group's tags are hidden. */
    const countOf = (g: string): number => (store ? h.labelsOf(g).filter((l) => isHidden(g, l.key)).length : 0);
    /** Custom: a hidden label whose rule is gone keeps a tile, so it can be shown again (and does not silently hide a later rule). */
    function withOrphans(rules: Label[]): Label[] {
        if (!store) return rules;
        return rules.concat(list('custom').filter((l) => !rules.some((r) => r.key === l)).map((l) => ({ key: l, name: T('{name} (no rule)', { name: l }) })));
    }

    const renamable = (g: string, l: string): boolean => !!texts && l !== ALL && TEXT_GROUPS.includes(g);
    /** The tag's text from the administrator, or ''. */
    const textOf = (g: string, l: string): string => (texts ? texts.get()[g]?.[l] : '') || '';

    /** The picked tag's Text field: empty keeps the tag's own words (its placeholder). */
    function buildTextRow(g: string, picked: Label): HTMLElement {
        const row = el('div', 'je-ts-text-row');
        const label = el('label', 'je-ta-switch-name', T('Text'));
        label.htmlFor = 'tagStyleText';
        const input = el('input');
        input.type = 'text';
        input.id = 'tagStyleText';
        input.maxLength = 32;
        input.placeholder = picked.name;
        input.value = textOf(g, picked.key);
        input.setAttribute('aria-describedby', 'tagStyleTextHint');
        // Saved when the field is left (or Enter is pressed): the row itself is not redrawn, so typing keeps focus.
        input.addEventListener('change', () => {
            texts?.set(g, picked, input.value.trim());
            h.renderTargets();
            h.renderSample();
            h.renderPreview();
        });
        const scope = el('span', 'je-ts-hide-scope', T('Replaces the whole chip text for everyone. Leave empty to keep "{name}".', { name: picked.name }));
        scope.id = 'tagStyleTextHint';
        row.append(label, input, scope);
        return row;
    }

    /** A language tile's code with its English name ("EN (English)"), as the page is in English. */
    function languageName(label: Label): string {
        const code = label.name.toUpperCase();
        try {
            const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(label.key);
            return name && name.toLowerCase() !== label.key ? code + ' (' + name + ')' : code;
        } catch { return code; }
    }
    /** What a tile hides, as the switch and the confirmation name it ("Other genres", "EN (English)", "PG-13 and 146 more ratings"). */
    function hideNoun(g: string, label: Label): string {
        if (g === 'ageRating') {
            const ages = ratingsOf(label.key).length;
            if (ages > 1) return T('{name} and {count} more ratings', { name: nb(label.name), count: ages - 1 });
        }
        if (g === 'genre' && label.key === 'other') return T('Other genres');
        if (g === 'logos') return ({ provider: T('provider logos'), company: T('network and studio logos'), text: T('name chips') } as Record<string, string>)[label.key] || label.name;
        if (g === 'language') return ({ subtitles: T('subtitle chips'), countBadge: T('Dual and Multi badges'), dual: T('the Dual badge'), multi: T('the Multi badge') } as Record<string, string>)[label.key] || languageName(label);
        return label.name;
    }
    /** A hidden tile's name in the hidden line: age tiles carry how many ratings they stand for. */
    function hiddenTileName(g: string, label: Label): string {
        if (g !== 'ageRating') return label.name;
        const ages = ratingsOf(label.key).length;
        return ages > 1 ? nb(label.name) + ' (+' + (ages - 1) + ')' : nb(label.name);
    }
    /** What hiding a tile does, in words. */
    function hideDescription(g: string, label: Label): string {
        const name = label.name;
        if (g === 'genre') return label.key === 'other'
            ? T('Hides every genre without an icon of its own (Reality, Talk, Anime and the like) from posters. The next genres take their places.')
            : T('Hides {name} from posters, in every spelling and language. The next genres take its place.', { name });
        if (g === 'ageRating') {
            const ratings = ratingsOf(label.key);
            const examples = ['G', 'PG', 'PG-13', 'R', 'NC-17', 'TV-14', 'TV-MA', '12A', '15', '18', 'NR'].filter((r) => ratings.includes(r)).concat(ratings).filter((r, i, a) => a.indexOf(r) === i).slice(0, 3);
            return ratings.length > 3
                ? T('Hides every rating that shares these colours from posters, such as {examples}.', { examples: examples.map(nb).join(', ') })
                : T('Hides these ratings from posters: {ratings}.', { ratings: ratings.map(nb).join(', ') });
        }
        if (g === 'logos') return ({ provider: T('Hides provider (streaming service) logos from posters. The next logos take their place.'),
            company: T('Hides network and studio logos from posters. The next logos take their place.'),
            text: T('Hides logos without an image (name chips) from posters. The next logos take their place.') } as Record<string, string>)[label.key] || '';
        if (g === 'language') return ({ subtitles: T('Hides subtitle chips from posters.'), countBadge: T('Hides the Dual and Multi badges from posters.'),
            dual: T('Hides the Dual badge from posters.'), multi: T('Hides the Multi badge from posters.') } as Record<string, string>)[label.key]
            || T('Hides {name} audio and subtitle chips from posters. The next languages take its place; the Dual and Multi badges still count it.', { name: languageName(label).replace(/^[A-Z]+ \((.+)\)$/, '$1') });
        return T('Hides {name} from posters, native posters included. The next tags take its place.', { name });
    }

    /** Redraw what shows hidden state (the confirmation announces the change, so the header stays quiet). */
    function refreshViews(): void {
        const now = find(root, '#tagStyleEditingNow');
        now?.removeAttribute('aria-live');
        h.renderTabs();
        h.renderTargets();
        renderHideRow();
        h.renderSample();
        h.renderPreview();
        // Live again only after this change has been observed (not announced).
        setTimeout(() => now?.setAttribute('aria-live', 'polite'), 250);
    }

    /** Hide or show one tile's chips and hand the whole document to the store. */
    function setHidden(g: string, label: Label, on: boolean): void {
        if (!store) return;
        const doc: Record<string, string[]> = {};
        for (const { key } of GROUPS) {
            let labels = list(key);
            if (key === g) labels = on ? labels.concat(labels.includes(label.key) ? [] : [label.key]) : labels.filter((l) => l !== label.key);
            if (labels.length) doc[pascal(key)] = labels;
        }
        const next = Object.keys(doc).length ? doc : null;
        // The web matches age rating badges by the ratings on a board.
        const boards = next?.AgeRating;
        const ages = boards ? h.ages().filter((a) => boards.includes(a.id)).flatMap((a) => a.ratings) : [];
        const count = g === 'ageRating' ? ratingsOf(label.key).length : 1;
        // A Custom label whose rule is gone has a tile only while hidden: showing it again ends it.
        const orphan = g === 'custom' && !h.customLabels().includes(label.key);
        const noun = hideNoun(g, label);
        store.set(next, ages, { group: g, label, hidden: on, count, orphan, noun: noun.charAt(0).toUpperCase() + noun.slice(1) });
        if (!on && orphan) {
            h.pick(ALL);
            h.renderTabs();
            h.renderPreview();
            find(root, '#tagStyleTargets .je-ts-target-all')?.focus();
            return;
        }
        refreshViews();
    }

    /** A group that hides tags says so on its tab (hiding is silent for every user). */
    function markTab(tab: HTMLElement, group: { key: string; title: string }): void {
        const count = countOf(group.key);
        if (!count) return;
        const mark = el('span', 'je-ts-tab-hidden');
        mark.append(hiddenIcon(), String(count));
        tab.appendChild(mark);
        tab.setAttribute('aria-label', T('{group}, {count} hidden', { group: group.title, count }));
    }
    /** The phone's group select names the count too. */
    const optionSuffix = (g: string): string => { const count = countOf(g); return count ? ' ' + T('({count} hidden)', { count }) : ''; };

    /** The picked tag's " · hidden" beside its name above the list. */
    function markNow(now: HTMLElement, label: Label | null | undefined): void {
        if (!label || !shownHidden(h.current(), label.key)) return;
        const flag = el('span', 'je-ts-now-hidden');
        flag.append(' · ', hiddenIcon(), T('hidden'));
        now.appendChild(flag);
    }

    /** A tile's sample chip; a hidden tile says so: dimmed, with the hidden mark on its chip's corner and in its name. */
    function tile(cell: HTMLElement, sample: HTMLElement, label: Label): void {
        const g = h.current();
        if (!shownHidden(g, label.key)) {
            const text = textOf(g, label.key);
            if (!text) { cell.appendChild(sample); return; }
            // A renamed tile says so: the pencil mark, and the new words in its tooltip.
            cell.title = T('{name} shows as "{text}"', { name: cell.title, text });
            const renamed = el('span', 'je-ts-chip-wrap');
            const pencil = el('i', 'material-icons je-ts-hidden-mark je-ts-renamed-mark', 'edit');
            pencil.setAttribute('aria-hidden', 'true');
            renamed.append(sample, pencil);
            cell.appendChild(renamed);
            return;
        }
        cell.classList.add('je-ts-target-hidden');
        const name = cell.getAttribute('aria-label') || '';
        cell.setAttribute('aria-label', coveredBy(g, label.key) && !isHidden(g, label.key) ? T('{name}, hidden by Dual and Multi badges', { name }) : T('{name}, hidden', { name }));
        cell.title = T('{name} (hidden)', { name: cell.title });
        const wrap = el('span', 'je-ts-chip-wrap');
        wrap.append(sample, hiddenIcon('material-icons je-ts-hidden-mark'));
        cell.appendChild(wrap);
    }

    /** The hint under the list's title, with the view it shows or how far it scrolls. */
    function hint(scrolls: boolean): string {
        const g = h.current();
        const base = T(!store ? 'Choose a tag to change only its colours.'
            : texts && TEXT_GROUPS.includes(g) ? 'Choose a tag to change its colours or text, or hide it.' : 'Choose a tag to change its colours or hide it.');
        if (h.hiddenOnly()) return base + ' ' + T('Showing the {count} hidden tags only.', { count: countOf(g) });
        return base + (scrolls ? ' ' + T('{count} tags; scroll for more.', { count: h.labelsOf(g).length }) : '');
    }

    /**
     * The hidden tags by name on their own line, each a way to its switch (a long list can scroll them
     * out of view); more than four: a view of the hidden tags only.
     */
    function renderLine(): void {
        const line = find(root, '#tagStyleHiddenLine');
        if (!line) return;
        const g = h.current();
        const hidden = store ? h.labelsOf(g).filter((l) => isHidden(g, l.key)) : [];
        line.hidden = !hidden.length;
        line.textContent = '';
        if (!hidden.length) return;
        line.append(hiddenIcon(), T('Hidden ({count}):', { count: hidden.length }) + ' ');
        hidden.slice(0, 4).forEach((l, i) => {
            if (i) line.append(', ');
            const go = el('button', 'je-ts-hidden-pick', hiddenTileName(g, l));
            go.type = 'button';
            go.setAttribute('aria-label', T('{name}, hidden: go to its switch', { name: hiddenTileName(g, l) }));
            go.addEventListener('click', () => { h.pick(l.key); (find(root, '#tagStyleHide') || find(root, '#tagStyleTargets .je-ts-target[tabindex="0"]'))?.focus(); });
            line.appendChild(go);
        });
        if (hidden.length > 4) line.append(' ' + T('and {count} more', { count: hidden.length - 4 }));
        if (hidden.length > 4 || h.hiddenOnly()) {
            // A view switch, set apart from the names (the hint says which view is on).
            line.append(' · ');
            const view = el('button', 'je-ts-hidden-view', h.hiddenOnly() ? T('Show every tag') : T('Show only the hidden tags'));
            view.type = 'button';
            view.dataset.tsHiddenView = '';
            view.addEventListener('click', () => { h.setHiddenOnly(!h.hiddenOnly()); h.renderTargets(); find(root, '[data-ts-hidden-view]')?.focus(); });
            line.appendChild(view);
        }
    }

    /**
     * The picked tag's Hide switch, above the group note and the colour rows (it decides whether the tag
     * shows at all). Picks without one say why: Whole group, and the language styles that colour every
     * flag or code.
     */
    function renderHideRow(): void {
        const box = find(root, '#tagStyleHideRow');
        if (!box || !store) return;
        h.rebuildKeepingFocus(box, () => {
            box.textContent = '';
            const g = h.current();
            const picked = h.target() === ALL ? null : h.labelsOf(g).find((l) => l.key === h.target());
            if (!picked) {
                // Whole group: hiding is per tag; the Groups tab (linked) turns a group off, for new users.
                const line = el('p', 'je-ts-hide-none');
                const back = el('a', 'je-ta-link je-ts-inline-link', T('Groups › {group}', { group: GROUPS.find((x) => x.key === g)?.title || g }));
                back.href = '#';
                back.dataset.jeGoto = 'groups:' + g;
                line.append(T('Hiding works per tag. To turn the whole group off for new users, see '), back, '.');
                box.appendChild(line);
                if (texts && TEXT_GROUPS.includes(g)) box.appendChild(el('p', 'je-ts-hide-none', T('To change the words a tag shows, choose it in the list: its Text field is at the top of its settings.')));
                return;
            }
            // Hidden only through the Dual and Multi badges tag: a way to that tag's switch. (Hidden on its own
            // as well, it keeps its own switch, with the same line under it.)
            const coveredLine = (): HTMLElement => {
                const line = el('p', 'je-ts-hide-none');
                const go = el('button', 'je-ts-hidden-pick', T('Dual and Multi badges'));
                go.type = 'button';
                go.addEventListener('click', () => { h.pick('countBadge'); find(root, '#tagStyleHide')?.focus(); });
                line.append(isHidden(g, picked.key) ? T('Also hidden by ') : T('Hidden by '), go, isHidden(g, picked.key) ? '.' : T('. Turn that off to show this badge again.'));
                return line;
            };
            if (coveredBy(g, picked.key) && !isHidden(g, picked.key)) { box.appendChild(coveredLine()); return; }
            if (!hideable(g, picked.key)) {
                box.appendChild(el('p', 'je-ts-hide-none', picked.key === 'flag' ? T('This colours every flag. To hide one language, choose its code.')
                    : T('This colours every language code. To hide one language, choose its code.')));
                return;
            }
            const sw = el('label', 'je-ta-switch je-ts-hide-switch');
            const input = el('input');
            input.type = 'checkbox';
            input.checked = isHidden(g, picked.key);
            input.dataset.tsKey = 'hide';
            input.id = 'tagStyleHide';
            // Named by its name alone; the scope sentence is its description (not read twice).
            input.setAttribute('aria-labelledby', 'tagStyleHideName');
            input.setAttribute('aria-describedby', 'tagStyleHideDesc');
            input.addEventListener('change', () => setHidden(g, picked, input.checked));
            const text = el('span', 'je-ta-switch-text');
            const name = el('span', 'je-ta-switch-name', T('Hide {name}', { name: hideNoun(g, picked) }));
            name.id = 'tagStyleHideName';
            // Scope, not help: it stays when the page hides descriptions.
            const desc = el('span', 'je-ts-hide-scope', hideDescription(g, picked));
            desc.id = 'tagStyleHideDesc';
            text.append(name, desc);
            sw.append(input, text);
            box.appendChild(sw);
            if (coveredBy(g, picked.key)) box.appendChild(coveredLine());
            if (renamable(g, picked.key)) box.appendChild(buildTextRow(g, picked));
            // An age board's every rating, on request (the switch reads only the short sentence).
            const ratings = g === 'ageRating' ? ratingsOf(picked.key) : [];
            if (ratings.length > 3) {
                const more = el('details', 'je-ts-hide-ratings');
                more.dataset.jeInfo = '';
                const summary = el('summary');
                const icon = el('i', 'material-icons', 'expand_more');
                icon.setAttribute('aria-hidden', 'true');
                summary.append(icon, T('Show all {count} ratings', { count: ratings.length }));
                more.append(summary, el('p', 'je-ts-hide-ratings-list', ratings.map(nb).join(', ')));
                box.appendChild(more);
            }
        });
    }

    /** Whether the preview leaves a sample chip out (it is hidden). */
    function previewHides(g: string, label: Label): boolean {
        if (!store) return false;
        if (g === 'ageRating') return list('ageRating').some((id) => ratingsOf(id).includes(label.name));
        // The preview's flag stands for English.
        if (g === 'language' && label.key === 'flag') return isHidden('language', 'en');
        return isHidden(g, label.key);
    }
    /** Sample genres for a preview card: its own, with hidden ones replaced by the next genres that show. */
    function previewGenres(own: readonly string[]): string[] {
        const pool = own.concat(h.labelsOf('genre').map((l) => l.key)).filter((k, i, a) => a.indexOf(k) === i && !(store && isHidden('genre', k)));
        return pool.slice(0, own.length);
    }

    /** Say, beside the colour rows, that tag colours are off. The switch's name is a way to it (it never turns colours on: that recolours every poster). */
    function setColoursOffNote(off: boolean, focusSwitch?: () => void): void {
        const note = find(root, '#tagStyleOffRowNote');
        if (!note) return;
        note.hidden = !off;
        if (!off) { note.textContent = ''; return; }
        const icon = el('i', 'material-icons', 'info');
        icon.setAttribute('aria-hidden', 'true');
        const go = el('a', 'je-ta-link je-ts-inline-link', T('Use tag colours'));
        go.href = '#tagStylesEnabled';
        go.addEventListener('click', (e) => { e.preventDefault(); focusSwitch?.(); });
        const text = el('span');
        text.append(T('Tag colours are off: these colours show once '), go, T(' is on.'));
        note.replaceChildren(icon, text);
    }

    /** Open a group with its tag list (Groups tab pointers). */
    function openGroup(group: string): void {
        if (!GROUPS.some((g) => g.key === group)) return;
        // The link names hidden tags: land on the first one (its switch, on, right below), else Whole group.
        const first = store ? h.labelsOf(group).find((l) => isHidden(group, l.key)) : null;
        h.open(group, first ? first.key : ALL);
        // The group's tab row at the top, clear of the sticky header (the page's scroll margin); focus does not scroll again.
        const tab = find(root, '#tagStyleTab-' + group);
        (tab && tab.offsetParent ? tab : find(root, '#tagStyleGroupSelect') || find(root, '#tagStyleTabs'))?.scrollIntoView?.({ block: 'start' });
        (find(root, '#tagStyleTargets .je-ts-target[tabindex="0"]') || tab)?.focus?.({ preventScroll: true });
    }

    return { isHidden, shownHidden, countOf, withOrphans, markTab, optionSuffix, markNow, tile, hint, renderLine, renderHideRow, refreshViews, previewHides, previewGenres, setColoursOffNote, openGroup };
}
