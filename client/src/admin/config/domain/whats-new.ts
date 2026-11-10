import { asObject, isObject, text } from './config';

export interface MediaTagsPlace { page?: string; tab: string; group: string | null }

/** GET whats-new `mediaTags`: where on the Media Tags tab each new setting lives. Unusable entries are left out. */
export function mediaTagsLocations(value: unknown): Record<string, MediaTagsPlace> {
    const places: Record<string, MediaTagsPlace> = {};
    for (const [id, place] of Object.entries(asObject(value))) {
        if (!isObject(place) || !text(place.tab)) continue;
        places[id] = { page: text(place.page), tab: text(place.tab), group: text(place.group) || null };
    }
    return places;
}

/** A banner line that opens a place on the Media Tags tab. */
export interface MediaTagsWhatsNewEntry {
    tab: string;
    tabLabel: string;
    title: string;
    href: string;
    mediaTags: { section: string; group: string | null };
    ids: string[];
}

export function humanizeSettingId(id: string): string {
    var spaced = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function mediaTagsWhatsNewEntries(ids: readonly string[], locations: Readonly<Record<string, MediaTagsPlace | undefined>>): MediaTagsWhatsNewEntry[] {
    // The page is plain English: no translation keys.
    var groupName = function(group: string): string {
        const names: Readonly<Record<string, string>> = {people:'People',quality:'Quality',rating:'Rating',ageRating:'Age Rating',language:'Language',genre:'Genre',status:'Status',awards:'Awards',logos:'Logos',custom:'Custom'};
        return names[group] || humanizeSettingId(group);
    };
    var entries: Record<string, MediaTagsWhatsNewEntry> = {};
    var order: string[] = [];
    ids.forEach(function(id) {
        var at = locations[id];
        if (!at || !at.tab) return;
        var group = at.tab === 'groups' && at.group ? at.group : null;
        var key = at.tab + ':' + (group || '');
        let entry = entries[key];
        if (!entry) {
            const tabNames: Readonly<Record<string, string>> = {overview:'Overview',layout:'Layout defaults',groups:'Groups',rules:'Rules',colours:'Colours',badges:'Status badges',server:'Server'};
            var tabName = tabNames[at.tab] || humanizeSettingId(at.tab);
            entry = entries[key] = {
                tab: 'media-tags',
                tabLabel: 'Media Tags',
                title: group ? tabName + ' \u203a ' + groupName(group) : tabName,
                href: '#/configurationpage?name=Jellyfin%20Enhanced&jeSection=media-tags&tab=' + encodeURIComponent(at.tab) + (group ? '&group=' + encodeURIComponent(group) : ''),
                mediaTags: { section: at.tab, group: group },
                ids: []
            };
            order.push(key);
        }
        entry.ids.push(id);
    });
    return order.flatMap(function(key) { const entry = entries[key]; return entry ? [entry] : []; });
}
