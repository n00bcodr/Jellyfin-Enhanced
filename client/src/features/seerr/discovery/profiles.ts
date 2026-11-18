// Saved filters: a user's own named sets of the Filters menu's filters (All / Movies / Series, the order, the further
// filters and each list's match), kept on the server per user (GET, POST and DELETE under
// user-settings/{userId}/discovery-filter-profiles), in the address form the pages read (address.ts). The Filters
// menu's first group lists them: choosing one applies it at once on the page it narrows (which takes the filters it
// offers), the bin beside one deletes it (with Undo), and a field saves what is set now under a name.
import type { DiscoveryApiClient, SeerrDiscoveryHost } from '../host-discovery';
import { filterTokens } from './filter-groups';
import type { FilterId, FilterScope, GroupHandle, MenuGroup, ProfilesHost, Say } from './types';

/** One saved set: its id, its name, and its filters in the address form (`jeType=movies&jeScore=7..`). */
export interface FilterProfile { readonly id: string; readonly name: string; readonly filters: string }
interface ProfilesAnswer { readonly max: number; readonly profiles: FilterProfile[] }
/** The profiles as last read, for the visit and the user: the request, and its answer once in. */
interface Held { readonly user: string; readonly asked: Promise<ProfilesAnswer>; list: FilterProfile[] | null; max: number }
export interface ProfilesGroupOptions {
    readonly label: Say;
    readonly host: ProfilesHost;
    readonly scope?: FilterScope;
    readonly offered?: readonly FilterId[];
    readonly locale?: string;
}

const PROFILES_API = 'discovery-filter-profiles';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isProfile = (value: unknown): value is FilterProfile => isRecord(value)
    && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.filters === 'string';
/** A list of profiles with one saved: in its place where it was there (a name saved over), else last, as the server keeps them. */
const withProfile = (list: readonly FilterProfile[], saved: FilterProfile): FilterProfile[] => {
    const at = list.findIndex(profile => profile.id === saved.id);
    return at < 0 ? [...list, saved] : list.map((profile, index) => index === at ? saved : profile);
};
/** Why the server refused a save: ApiClient.ajax refuses with the fetch Response, whose body says why. */
async function refusal(error: unknown): Promise<unknown> {
    if (!isRecord(error)) return null;
    const said = isRecord(error.responseJSON) ? error.responseJSON.error : error.error;
    if (said) return said;
    if (typeof error.json !== 'function') return null;
    try {
        const body: unknown = await error.json();
        return isRecord(body) ? body.error : null;
    } catch { return null; }
}

export function createProfiles(JE: SeerrDiscoveryHost, api: () => DiscoveryApiClient | undefined) {
    let held: Held | null = null;
    /** The client and the user signed in, where the client can reach the user's saved filters. */
    const client = (): { readonly ajax: NonNullable<DiscoveryApiClient['ajax']>; readonly user: string; url(path?: string): string } | null => {
        const found = api();
        const ajax = found?.ajax;
        if (!found || typeof ajax !== 'function') return null;
        let user = '';
        try { user = found.getCurrentUserId() ?? ''; } catch { user = ''; }
        if (!user) return null;
        return {
            ajax: request => ajax.call(found, request),
            user,
            url: (path = '') => found.getUrl(`/JellyfinEnhanced/user-settings/${user}/${PROFILES_API}${path}`)
        };
    };
    /** Whether this client can reach the user's saved filters. */
    const reachable = (): boolean => client() !== null;

    /** The user's saved profiles, asked of the server once per visit and user. */
    function load(): Promise<ProfilesAnswer> {
        const api = client();
        if (!api) return Promise.reject(new Error('Saved filters are not reachable'));
        const user = api.user;
        if (held?.user === user) return held.asked;
        const asked = api.ajax({ type: 'GET', url: api.url(), dataType: 'json' }).then((answer): ProfilesAnswer => ({
            max: isRecord(answer) ? Number(answer.max) || 0 : 0,
            profiles: isRecord(answer) && Array.isArray(answer.profiles) ? answer.profiles.filter(isProfile) : []
        }));
        const kept: Held = { user, asked, list: null, max: 0 };
        held = kept;
        // (Kept as answered, so a menu opened later says at once which profile is set.)
        asked.then(answer => { kept.list = answer.profiles; kept.max = answer.max; }, () => { if (held?.asked === asked) held = null; });
        return asked;
    }
    /** The profiles kept for this visit, changed as the server's were (else asked again next time). */
    function keep(change: (list: FilterProfile[]) => FilterProfile[]): void {
        const was = held;
        if (!was || was.user !== client()?.user || !Array.isArray(was.list)) { held = null; return; }
        const list = change(was.list);
        held = { user: was.user, list, max: was.max, asked: Promise.resolve({ max: was.max, profiles: list }) };
    }
    /** Saves the filters under a name (a profile of that name, in any case, takes them). */
    async function save(name: string, filters: string): Promise<FilterProfile> {
        const api = client();
        if (!api) throw new Error('Saved filters are not reachable');
        const answer: unknown = await api.ajax({
            type: 'POST', url: api.url(), data: JSON.stringify({ name, filters }), contentType: 'application/json', dataType: 'json'
        });
        const profile = isRecord(answer) ? answer.profile : null;
        if (!isProfile(profile)) throw new Error('The saved filters came back in an unknown shape');
        keep(list => withProfile(list, profile));
        return profile;
    }
    /** Deletes one of the user's profiles. */
    async function remove(id: string): Promise<void> {
        const api = client();
        if (!api) throw new Error('Saved filters are not reachable');
        await api.ajax({ type: 'DELETE', url: api.url(`/${encodeURIComponent(id)}`) });
        keep(list => list.filter(profile => profile.id !== id));
    }
    JE.session?.onUserChange('discovery-filter-profiles', () => { held = null; });

    /**
     * The Saved filters group: the user's profiles, each applied by choosing it (the menu then closes, and the list
     * behind reloads with them), a way to delete one, and a field to save what is set under a name. `host`: what is set
     * now in the address form, and how a profile's filters are applied by the page they narrow.
     */
    function group({ label: say, host, scope = 'feed', offered = [], locale = 'en' }: ProfilesGroupOptions): MenuGroup {
        const name = say('discovery_filter_profiles', 'Saved filters');
        const none = say('discovery_filter_profiles_none', 'None');
        /**
         * Filters in one written form, as this page takes them: a set saved elsewhere, or by an earlier version, with its
         * pairs in another order or another spelling, is still known as what is set.
         */
        const plain = (text: string): string => {
            const address = JE.discoveryAddress;
            if (!address) return text;
            try { return address.filterPairs(address.filtersOf(text, scope), true).join('&'); } catch { return text; }
        };
        /** Whether a profile is what is set now. */
        const isNow = (profile: FilterProfile): boolean => plain(profile.filters) === plain(host.read());
        /** What the row says: the profile that is what is set now, else how many there are. */
        const sayRow = (list: readonly FilterProfile[]): string => list.find(isNow)?.name
            ?? (list.length > 0 ? say('discovery_filter_profiles_count', '{count} saved', { count: list.length }) : none);
        // (The list as last answered, when there is one: the row then says which profile is set as the menu opens.)
        const known = held && held.user === client()?.user ? held.list : null;
        const now = known ? known.find(isNow) : undefined;
        return {
            id: 'profiles', name, any: known ? sayRow(known) : none, set: !!now, value: now?.name ?? none,
            build(body: HTMLElement, handle: GroupHandle) {
                const rows = document.createElement('div');
                rows.className = 'jellyseerr-menu-list';
                const status = document.createElement('div');
                status.className = 'jellyseerr-menu-note';
                status.setAttribute('aria-live', 'polite');
                const sayStatus = (words: string, error = false): void => {
                    status.textContent = words;
                    status.hidden = words === '';
                    status.toggleAttribute('data-error', error);
                };
                // The form: a name, and Save (what is set now, under that name).
                const form = document.createElement('div');
                form.className = 'jellyseerr-menu-range jellyseerr-menu-profile-form';
                const field = document.createElement('input');
                field.type = 'text';
                field.className = 'jellyseerr-menu-input';
                field.maxLength = 60;
                field.autocomplete = 'off';
                field.placeholder = say('discovery_filter_profile_name', 'Name these filters');
                field.setAttribute('aria-label', field.placeholder);
                const saveButton = document.createElement('button');
                saveButton.type = 'button';
                saveButton.className = 'jellyseerr-menu-profile-save emby-button raised';
                saveButton.textContent = say('discovery_filter_profile_save', 'Save');
                form.append(field, saveButton);
                let list: FilterProfile[] = [];
                /** What a profile sets, as this page would take it: the lists first, then the ranges, the type and the order. */
                const summaryOf = (filters: string): string[] => {
                    const read = JE.discoveryAddress?.filtersOf(filters, scope);
                    if (!read) return [];
                    const lists: string[] = [];
                    const ranges: string[] = [];
                    for (const token of filterTokens({ offered, label: say, locale, selection: read.selection })) {
                        const into = token.list ? lists : ranges;
                        // (Several of a list stay together, said with their rule: "dragon or witch".)
                        if (token.join && into.length > 0) {
                            into[into.length - 1] += ` ${token.join === 'or' ? say('discovery_filter_or', 'or') : say('discovery_filter_and', 'and')} ${token.words}`;
                        } else into.push(token.words);
                    }
                    const parts = [...lists, ...ranges];
                    if (read.mode === 'movies') parts.push(say('jellyseerr_quota_label_movie', 'Movies'));
                    else if (read.mode === 'tv') parts.push(say('jellyseerr_quota_label_tv', 'Series'));
                    const order = (JE.discoveryFilter?.SORT_OPTIONS ?? []).find(option => option.value !== '' && option.value === read.sort);
                    if (order) parts.push(say(order.labelKey, order.label));
                    return parts;
                };
                /** Says a profile was deleted, with the way back: Undo saves it again. */
                const sayUndo = (profile: FilterProfile): void => {
                    const undo = document.createElement('button');
                    undo.type = 'button';
                    undo.className = 'jellyseerr-menu-profile-undo';
                    undo.textContent = say('discovery_filter_profile_undo', 'Undo');
                    undo.addEventListener('click', () => {
                        undo.disabled = true;
                        const keyed = document.activeElement === undo;
                        save(profile.name, profile.filters).then(saved => {
                            if (!body.isConnected) return;
                            list = withProfile(list, saved);
                            draw();
                            sayStatus(say('discovery_filter_profile_restored', 'Restored “{name}”.', { name: saved.name }));
                            if (keyed) rows.querySelector<HTMLElement>('.jellyseerr-menu-profile-row:last-child .jellyseerr-menu-profile')?.focus();
                            handle.say(sayRow(list), list.some(isNow));
                            handle.placed();
                        }).catch(() => { undo.disabled = false; sayStatus(say('discovery_filter_profile_error', 'Could not save that. Try again.'), true); });
                    });
                    const sentence = document.createElement('span');
                    sentence.className = 'jellyseerr-menu-profile-said';
                    sentence.textContent = say('discovery_filter_profile_deleted', 'Deleted “{name}”.', { name: profile.name });
                    status.replaceChildren(sentence, ' ', undo);
                    status.hidden = false;
                    status.removeAttribute('data-error');
                };
                /** Save is there to press once there is something set and a name for it. */
                const canSave = (): void => { saveButton.disabled = host.read() === '' || field.value.trim() === ''; };
                /** Draws the profiles, the one that is what is set now marked. */
                const draw = (): void => {
                    const menu = JE.discoveryMenu;
                    if (!menu) return;
                    const setNow = host.read();
                    rows.replaceChildren(...list.map(profile => {
                        const current = isNow(profile);
                        const { item } = menu.menuRow(profile.name, 'check', !current);
                        item.classList.add('jellyseerr-menu-profile');
                        if (current) {
                            item.setAttribute('aria-current', 'true');
                            // (Marked as the sort menu marks its order, with a check: here before the name, in its line.)
                            const mark = document.createElement('span');
                            mark.className = 'material-icons check jellyseerr-menu-profile-mark';
                            mark.setAttribute('aria-hidden', 'true');
                            item.querySelector('.actionSheetItemText')?.prepend(mark);
                        }
                        // Under its name, what it sets, in the page's words ("Movies · Score from 7 · Animation and Fantasy").
                        const says = summaryOf(profile.filters);
                        if (says.length > 0) {
                            const line = document.createElement('div');
                            line.className = 'listItemBodyText secondary jellyseerr-menu-profile-says';
                            // (Each part whole on a line where it fits: a line breaks between parts, never inside "dragon or witch".)
                            line.append(...says.flatMap((part, index): Array<HTMLElement | string> => {
                                const piece = document.createElement('span');
                                piece.className = 'jellyseerr-menu-profile-part';
                                piece.textContent = index < says.length - 1 ? `${part} ·` : part;
                                return index < says.length - 1 ? [piece, ' '] : [piece];
                            }));
                            item.querySelector('.actionsheetListItemBody')?.appendChild(line);
                        }
                        item.addEventListener('click', () => { handle.close?.(); host.apply(profile.filters); });
                        const removeButton = document.createElement('button');
                        removeButton.type = 'button';
                        removeButton.className = 'jellyseerr-menu-profile-delete';
                        const removeLabel = say('discovery_filter_profile_delete', 'Delete {name}', { name: profile.name });
                        removeButton.setAttribute('aria-label', removeLabel);
                        removeButton.title = removeLabel;
                        // (A bin, not the cross that takes a filter away on the page: this deletes what is kept.)
                        const bin = document.createElement('span');
                        bin.className = 'material-icons delete_outline';
                        bin.setAttribute('aria-hidden', 'true');
                        removeButton.appendChild(bin);
                        removeButton.addEventListener('click', event => {
                            event.stopPropagation();
                            removeButton.disabled = true;
                            const at = list.indexOf(profile);
                            const keyed = document.activeElement === removeButton;
                            remove(profile.id).then(() => {
                                list = list.filter(entry => entry.id !== profile.id);
                                draw();
                                // (Deleted with the keys on it, they go to the next one's delete, the one before, or the name field.)
                                if (keyed) {
                                    const deletes = rows.querySelectorAll<HTMLElement>('.jellyseerr-menu-profile-delete');
                                    const head = body.previousElementSibling instanceof HTMLElement ? body.previousElementSibling : null;
                                    (deletes[Math.min(at, deletes.length - 1)] ?? (field.disabled ? head : field))?.focus();
                                }
                                sayUndo(profile);
                                handle.say(sayRow(list), list.some(isNow));
                                handle.placed();
                            }).catch(() => {
                                removeButton.disabled = false;
                                sayStatus(say('discovery_filter_profile_error', 'Could not save that. Try again.'), true);
                            });
                        });
                        const wrap = document.createElement('div');
                        wrap.className = 'jellyseerr-menu-profile-row';
                        wrap.append(item, removeButton);
                        return wrap;
                    }));
                    // (Nothing set: nothing to save.)
                    const empty = setNow === '';
                    field.disabled = empty;
                    canSave();
                    if (empty) sayStatus(say('discovery_filter_profile_nothing', 'Set a filter to save it here.'));
                };
                field.addEventListener('input', canSave);
                const store = async (): Promise<void> => {
                    const words = field.value.trim();
                    if (!words) { field.focus(); return; }
                    saveButton.disabled = true;
                    try {
                        const saved = await save(words, host.read());
                        list = withProfile(list, saved);
                        field.value = '';
                        draw();
                        sayStatus(say('discovery_filter_profile_saved', 'Saved as “{name}”.', { name: saved.name }));
                        handle.say(sayRow(list), true);
                    } catch (error) {
                        const reason = await refusal(error);
                        sayStatus(reason === 'full' ? say('discovery_filter_profile_full', 'Delete a saved one first: you have the most there can be.')
                            : say('discovery_filter_profile_error', 'Could not save that. Try again.'), true);
                    } finally {
                        canSave();
                        handle.placed();
                    }
                };
                saveButton.addEventListener('click', () => { void store(); });
                field.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void store(); } });
                sayStatus(say('discovery_filter_loading', 'Loading…'));
                body.append(rows, form, status);
                load().then(answer => {
                    if (!body.isConnected) return;
                    list = answer.profiles;
                    sayStatus('');
                    draw();
                    handle.say(sayRow(list), list.some(isNow));
                    handle.placed();
                }).catch(() => { sayStatus(say('discovery_filter_unavailable', 'Could not load these.'), true); handle.placed(); });
            }
        };
    }

    return { reachable, load, group };
}
export type DiscoveryProfiles = ReturnType<typeof createProfiles>;
