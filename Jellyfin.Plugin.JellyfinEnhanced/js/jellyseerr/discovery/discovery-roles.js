// /js/jellyseerr/discovery/discovery-roles.js
// The line under a person's titles that says what the person did in each, fitted to its card.
// A line that does not fit loses whole parts or jobs from its end, never part of a word, and says
// how many it left out ("Director, Writer +1"); the card's tooltip keeps them all. One part too long
// on its own loses what it has in brackets, then whole words ("as Professor Marmalade…"). A job asked for
// by the Role filter leads its line, so it is the last to go.
//
// Public surface: JE.discoveryRoles { decorateCard, fitRoleLines, ROLE_ASKED }.
(function(JE) {
    'use strict';

    /** The crew departments the section's Role filter asks for, as the section itself records them. */
    const ROLE_ASKED = 'data-role-asked';

    /**
     * A string in the viewer's language, or the source's English where there is none, with its values put in.
     * @param {string} key - The translation key
     * @param {string} fallback - The English words
     * @param {object} [values] - Values for `{name}` placeholders
     * @returns {string}
     */
    function label(key, fallback, values) {
        const text = typeof JE.t === 'function' ? JE.t(key, values) : '';
        let said = text && text !== key ? text : fallback;
        for (const [name, value] of Object.entries(values ?? {})) said = said.replace(`{${name}}`, String(value));
        return said;
    }

    /**
     * The first `shown` of `items`, and how many it left out ("Director, Writer +1").
     * @param {string[]} items - The parts or jobs
     * @param {number} shown - How many to say
     * @returns {string}
     */
    const said = (items, shown) =>
        `${items.slice(0, shown).join(', ')}${shown < items.length ? ` +${items.length - shown}` : ''}`;

    /**
     * On a person's titles: what the person did in this one, on a line of its own under the title
     * (as Jellyfin's cast cards put the part under the name). Every card of the list has the line,
     * empty where Seerr named no part or job, so the rows of the grid stay level. Does nothing for a
     * card whose item has no `jeCredit` (every list but a person's).
     * @param {HTMLElement} card - The card `createJellyseerrCard` made
     * @param {object} item - The Seerr result, with `jeCredit` on a person's titles
     */
    function decorateCard(card, item) {
        const credit = item?.jeCredit;
        if (!card || !credit) return;
        // The part is one thing and the jobs another ("as Joseph" / "Director, Writer"): each has its own
        // line where a title has both, so the jobs are not read as more parts played.
        // (TMDB's job "Creator" is said as the Role filter says its department.)
        const characters = Array.isArray(credit.characters) ? credit.characters : [];
        const crew = Array.isArray(credit.crew) ? credit.crew : [];
        const jobs = crew.map(([job, department]) => [job === 'Creator' ? label('discovery_role_creator', 'Creator') : job, department]);
        const parts = [characters.length ? label('discovery_role_as', 'as {role}', { role: characters.join(', ') }) : '', jobs.map(([job]) => job).join(', ')];
        const spoken = parts.filter(Boolean);
        const line = document.createElement('div');
        line.className = 'cardText cardTextCentered cardText-secondary jellyseerr-role';
        if (spoken.length > 1) line.classList.add('jellyseerr-role-both');
        if (spoken.length > 0) line.title = spoken.join('\n');
        for (const [index, words] of (spoken.length > 0 ? parts : [' ']).entries()) {
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

    /**
     * Fits every such line of a section: after its cards are drawn, after the Role filter changed, and when the cards' width changes.
     * @param {Element|null|undefined} section - The discovery section
     */
    function fitRoleLines(section) {
        if (!section) return;
        const asked = new Set((section.getAttribute(ROLE_ASKED) ?? '').split('|').filter(Boolean));
        const lines = Array.from(section.querySelectorAll('.jellyseerr-role > [data-jobs], .jellyseerr-role > [data-parts]')).map(line => {
            let items = [];
            let wrap = (words) => words;
            try {
                if (line.dataset.jobs !== undefined) {
                    const jobs = JSON.parse(line.dataset.jobs);
                    items = [...jobs.filter(job => asked.has(job[1])), ...jobs.filter(job => !asked.has(job[1]))].map(job => job[0]);
                } else {
                    items = JSON.parse(line.dataset.parts ?? '[]');
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
            const fits = (words) => { line.textContent = wrap(words); return line.scrollWidth <= line.clientWidth + 1; };
            let done = false;
            for (let shown = items.length - 1; shown >= 1 && !done; shown--) done = fits(said(items, shown));
            if (done) continue;
            // The first alone does not fit: without what it has in brackets, then with fewer of its words (never part of a word).
            const more = items.length > 1 ? ` +${items.length - 1}` : '';
            const words = (items[0] ?? '').replace(/\s*[(（].*$/, '').split(/\s+/).filter(Boolean);
            for (let count = words.length; count >= 1 && !done; count--) done = fits(`${words.slice(0, count).join(' ')}…${more}`);
        }
    }

    // ---- Styles: the role line ----------------------------------------------------------------------

    const STYLE_ID = 'jellyseerr-discovery-roles-styles';
    /** Puts this module's stylesheet in the page once. */
    function injectStyles() {
        if (typeof document === 'undefined' || !document.head || document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            /* On a person's titles: what the person did in each (the part played, the job held), one line under the title. */
            .jellyseerr-discovery-section .jellyseerr-role > bdi { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            /* The part and the jobs are a line each. Where a title of the list has both, every card keeps two lines, so the rows stay level. */
            /* Asked for by a job and not for acting (the Role filter), the jobs come before the part. */
            .jellyseerr-discovery-section[data-jobs-first] .jellyseerr-role-both { display: flex; flex-direction: column-reverse; }
            .jellyseerr-discovery-section .itemsContainer:has(.jellyseerr-role-both) .jellyseerr-role { min-height: 2.7em; min-height: 2lh; }
        `;
        document.head.appendChild(style);
    }

    injectStyles();

    JE.discoveryRoles = { decorateCard, fitRoleLines, ROLE_ASKED };
})(window.JellyfinEnhanced || (window.JellyfinEnhanced = {}));
