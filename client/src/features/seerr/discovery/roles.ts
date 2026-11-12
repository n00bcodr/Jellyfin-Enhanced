// The line under a person's titles that says what the person did in each, fitted to its card.
// A line that does not fit loses whole parts or jobs from its end, never part of a word, and says
// how many it left out ("Director, Writer +1"); the card's tooltip keeps them all. One part too long
// on its own loses what it has in brackets, then whole words ("as Professor Marmalade…"). A job asked for
// by the Role filter leads its line, so it is the last to go.
// Published as JE.discoveryRoles { decorateCard, fitRoleLines, ROLE_ASKED }.
import rolesCss from './discovery-roles.css';
import { injectStyleOnce } from './discovery-styles';
import type { DiscoveryRolesFacade, SeerrResult, Say } from './types';

/** The crew departments the section's Role filter asks for, as the section itself records them. */
export const ROLE_ASKED = 'data-role-asked';

/** The first `shown` of `items`, and how many it left out ("Director, Writer +1"). */
const said = (items: readonly string[], shown: number): string =>
    `${items.slice(0, shown).join(', ')}${shown < items.length ? ` +${items.length - shown}` : ''}`;

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(entry => typeof entry === 'string');
const isJobList = (value: unknown): value is Array<[string, string]> => Array.isArray(value)
    && value.every(entry => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string');

export function createDiscoveryRoles(label: Say): DiscoveryRolesFacade {
    /**
     * On a person's titles: what the person did in this one, on a line of its own under the title
     * (as Jellyfin's cast cards put the part under the name). Every card of the list has the line,
     * empty where Seerr named no part or job, so the rows of the grid stay level. Does nothing for a
     * card whose item has no `jeCredit` (every list but a person's).
     */
    function decorateCard(card: HTMLElement | null | undefined, item: SeerrResult | null | undefined): void {
        const credit = item?.jeCredit;
        if (!card || !credit) return;
        // The part is one thing and the jobs another ("as Joseph" / "Director, Writer"): each has its own
        // line where a title has both, so the jobs are not read as more parts played.
        // (TMDB's job "Creator" is said as the Role filter says its department.)
        const characters = Array.isArray(credit.characters) ? credit.characters : [];
        const crew = Array.isArray(credit.crew) ? credit.crew : [];
        const jobs = crew.map(([job, department]) => [job === 'Creator' ? label('discovery_role_creator', 'Creator') : job, department] as const);
        const parts = [characters.length ? label('discovery_role_as', 'as {role}', { role: characters.join(', ') }) : '', jobs.map(([job]) => job).join(', ')];
        const spoken = parts.filter(Boolean);
        const line = document.createElement('div');
        line.className = 'cardText cardTextCentered cardText-secondary jellyseerr-role';
        if (spoken.length > 1) line.classList.add('jellyseerr-role-both');
        if (spoken.length > 0) line.title = spoken.join('\n');
        for (const [index, words] of (spoken.length > 0 ? parts : ['\u00a0']).entries()) {
            if (!words) continue;
            const text = document.createElement('bdi');
            text.textContent = words;
            // (What the line is made of, for fitting it to the card: see fitRoleLines.)
            if (index === 1) text.dataset.jobs = JSON.stringify(jobs);
            else {
                // (TMDB gives several parts of one credit as one string, "A / B": each is a part.)
                const each = characters.flatMap(character => character.split(' / ')).map(character => character.trim()).filter(Boolean);
                text.dataset.parts = JSON.stringify(each.filter((character, at) => each.indexOf(character) === at));
                text.dataset.as = label('discovery_role_as', 'as {role}', { role: '{role}' });
            }
            line.appendChild(text);
        }
        const title = card.querySelector('.cardText-first');
        if (title) title.after(line);
        else card.appendChild(line);
    }

    /** Fits every such line of a section: after its cards are drawn, after the Role filter changed, and when the cards' width changes. */
    function fitRoleLines(section: Element | null | undefined): void {
        if (!section) return;
        const asked = new Set((section.getAttribute(ROLE_ASKED) ?? '').split('|').filter(Boolean));
        const lines = Array.from(section.querySelectorAll<HTMLElement>('.jellyseerr-role > [data-jobs], .jellyseerr-role > [data-parts]')).map(line => {
            let items: string[] = [];
            let wrap = (words: string): string => words;
            try {
                if (line.dataset.jobs !== undefined) {
                    const jobs: unknown = JSON.parse(line.dataset.jobs);
                    const list = isJobList(jobs) ? jobs : [];
                    items = [...list.filter(job => asked.has(job[1])), ...list.filter(job => !asked.has(job[1]))].map(job => job[0]);
                } else {
                    const parts: unknown = JSON.parse(line.dataset.parts ?? '[]');
                    items = isStringArray(parts) ? parts : [];
                    const as = line.dataset.as ?? '{role}';
                    wrap = words => as.replace('{role}', words);
                }
            } catch { items = []; }
            return { line, items, wrap };
        }).filter(entry => entry.items.length > 0);
        // Every line whole first, then one reading of which do not fit (writing and reading by turns would lay the list out once per card).
        for (const { line, items, wrap } of lines) {
            const whole = wrap(said(items, items.length));
            if (line.textContent !== whole) line.textContent = whole;
        }
        const tight = lines.filter(({ line }) => line.clientWidth > 0 && line.scrollWidth > line.clientWidth + 1);
        for (const { line, items, wrap } of tight) {
            const fits = (words: string): boolean => { line.textContent = wrap(words); return line.scrollWidth <= line.clientWidth + 1; };
            let done = false;
            for (let shown = items.length - 1; shown >= 1 && !done; shown--) done = fits(said(items, shown));
            if (done) continue;
            // The first alone does not fit: without what it has in brackets, then with fewer of its words (never part of a word).
            const more = items.length > 1 ? ` +${items.length - 1}` : '';
            const words = (items[0] ?? '').replace(/\s*[(（].*$/, '').split(/\s+/).filter(Boolean);
            for (let count = words.length; count >= 1 && !done; count--) done = fits(`${words.slice(0, count).join(' ')}…${more}`);
        }
    }

    injectStyleOnce('jellyseerr-discovery-roles-styles', rolesCss);
    return { decorateCard, fitRoleLines, ROLE_ASKED };
}
