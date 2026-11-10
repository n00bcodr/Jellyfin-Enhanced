import type { DefineSections } from '../engine/schema';

export function defineArr(define: DefineSections): void {
/* *arr tab sections. Sonarr/Radarr instance editors are custom items; their JS in configPage.html binds by id.
 * See jeAdmin.js for the field spec. */
define({
    'arr-sonarr': {
        title: 'Sonarr', iconImg: 'selfhst/svg/sonarr.svg', attrs: { 'data-dep-setup': '' },
        items: [
            { type: 'note', html: 'Automated TV show collection management and monitoring. Add one instance per Sonarr server.' },
            { type: 'custom', html: '<div id="sonarrInstancesList"></div>'
                + '<div class="je-arr-action-row"><button id="addSonarrInstance" class="jea-btn" type="button">+ Add Sonarr instance</button>'
                + '<button type="button" id="validateSonarrMappingsBtn" class="jea-btn">Validate Mappings</button>'
                + '<button id="importSonarrFromSeerr" class="jea-btn" type="button">Import from Seerr</button></div>'
                + '<div id="sonarrSeerrImportPicker" class="je-arr-seerr-import-picker" style="display:none;"></div>'
                + '<div id="sonarrMappingsValidationResult"></div>' }
        ]
    },
    'arr-radarr': {
        title: 'Radarr', iconImg: 'selfhst/svg/radarr-light-hybrid-light.svg', attrs: { 'data-dep-setup': '' },
        items: [
            { type: 'note', html: 'Automated movie collection management and monitoring. Add one instance per Radarr server.' },
            { type: 'custom', html: '<div id="radarrInstancesList"></div>'
                + '<div class="je-arr-action-row"><button id="addRadarrInstance" class="jea-btn" type="button">+ Add Radarr instance</button>'
                + '<button type="button" id="validateRadarrMappingsBtn" class="jea-btn">Validate Mappings</button>'
                + '<button id="importRadarrFromSeerr" class="jea-btn" type="button">Import from Seerr</button></div>'
                + '<div id="radarrSeerrImportPicker" class="je-arr-seerr-import-picker" style="display:none;"></div>'
                + '<div id="radarrMappingsValidationResult"></div>' }
        ]
    },
    'arr-bazarr': {
        title: 'Bazarr', iconImg: 'selfhst/svg/bazarr.svg', attrs: { 'data-dep-setup': '' },
        items: [
            { type: 'note', html: 'Automated subtitle downloading and management for Sonarr and Radarr. Single instance, no API key, detail-page links only.' },
            { id: 'bazarrUrl', prop: 'BazarrUrl', type: 'text', label: 'Bazarr URL', placeholder: 'e.g., http://192.168.100.100:6767',
              desc: 'This links to the main movies/series page; Bazarr does not support direct item deep-links.<br/>If Bazarr sits behind an auth proxy (Authentik, Authelia, Cloudflare Access, etc.), put the INTERNAL address here (e.g. <code>http://bazarr:6767</code>) and use the URL Mappings below to redirect user-facing links to the public URL.' },
            { id: 'bazarrUrlMappings', prop: 'BazarrUrlMappings', type: 'textarea', rows: 3, label: 'Bazarr URL Mappings', placeholder: 'jellyfin_url|bazarr_url',
              desc: 'Map Jellyfin access URLs to Bazarr URLs. Format: <code>jellyfin_url|bazarr_url</code> (one per line).' },
            { type: 'html', html: '<div class="je-arr-action-row"><button type="button" id="validateBazarrMappingsBtn" class="jea-btn">Validate Mappings</button></div><div id="bazarrMappingsValidationResult"></div>' }
        ]
    },
    'arr-shoko': {
        title: 'Shoko', iconImg: 'selfhst/svg/shoko-server.svg', attrs: { 'data-dep-setup': '' },
        items: [
            { type: 'note', html: 'Surfaces upcoming anime episodes from your Shoko Server collection on the Calendar page. Single instance, no admin-assigned name.' },
            { id: 'shokoUrl', prop: 'ShokoUrl', type: 'text', label: 'Shoko URL', placeholder: 'e.g., http://192.168.100.100:8111',
              desc: 'If Shoko sits behind an auth proxy (Authentik, Authelia, Cloudflare Access, etc.), put the INTERNAL address here (e.g. <code>http://shoko:8111</code>) and use the URL Mappings below to redirect user-facing links to the public URL.' },
            { id: 'shokoApiKey', prop: 'ShokoApiKey', type: 'text', showIf: 'shokoUrl', label: 'Shoko API Key',
              toConfig: (v) => (v || '').replace(/\s/g, ''),
              desc: 'API key from Shoko\'s web UI (Settings &gt; API Keys &gt; Add API Key).' },
            { type: 'group', showIf: 'shokoUrl', title: 'Episode types to show on Calendar', open: true, items: [
                { id: 'shokoShowEpisodes', prop: 'ShokoShowEpisodes', type: 'toggle', default: true, label: 'Episodes' },
                { id: 'shokoShowSpecials', prop: 'ShokoShowSpecials', type: 'toggle', label: 'Specials' },
                { id: 'shokoShowCredits', prop: 'ShokoShowCredits', type: 'toggle', label: 'Credits (OP/ED)' },
                { id: 'shokoShowTrailers', prop: 'ShokoShowTrailers', type: 'toggle', label: 'Trailers' },
                { id: 'shokoShowParodies', prop: 'ShokoShowParodies', type: 'toggle', label: 'Parodies' },
                { id: 'shokoShowOther', prop: 'ShokoShowOther', type: 'toggle', label: 'Other',
                  desc: 'Which AniDB episode types appear as calendar events. Episodes are on by default; the rest are usually calendar noise.' }
            ] },
            { type: 'group', showIf: 'shokoUrl', title: 'Advanced URL Mappings', items: [
                { id: 'shokoUrlMappings', prop: 'ShokoUrlMappings', type: 'textarea', rows: 3, label: 'Shoko URL Mappings', placeholder: 'jellyfin_url|shoko_url',
                  desc: 'Map Jellyfin access URLs to Shoko URLs. Format: <code>jellyfin_url|shoko_url</code> (one per line).' },
                { type: 'html', html: '<div class="je-arr-action-row"><button type="button" id="validateShokoMappingsBtn" class="jea-btn">Validate Mappings</button></div><div id="shokoMappingsValidationResult"></div>' }
            ] }
        ]
    },
    'arr-links': {
        title: '*arr UI Links', icon: 'link',
        items: [
            { id: 'arrLinksEnabled', prop: 'ArrLinksEnabled', type: 'toggle', main: true, label: 'Enable *arr Links on Detail Pages',
              desc: 'Show Sonarr, Radarr, and Bazarr links of the items on item detail pages for quick access. <strong>Admins only</strong>.<br/>If no URL is configured for a service, links for that service are not shown.' },
            { id: 'showArrLinksAsText', prop: 'ShowArrLinksAsText', type: 'toggle', label: 'Show links as text',
              desc: 'Render the *arr links as plain text labels instead of icon buttons.' },
            { id: 'arrLinksShowStatusSingle', prop: 'ArrLinksShowStatusSingle', type: 'toggle', label: 'Show status badge for single-instance',
              desc: 'When off (default), a single matching Sonarr/Radarr instance renders as a plain icon/text.<br/>When on, it also shows the episode count (e.g. 22/41) and a colored left border indicating download status. Multi-instance dropdowns always show this detail.' }
        ]
    },
    'arr-tags': {
        title: 'Tags Sync', icon: 'label',
        items: [
            { id: 'arrTagsSyncEnabled', prop: 'ArrTagsSyncEnabled', type: 'toggle', main: true, label: 'Enable Tags Sync',
              desc: 'Fetches all tags from Radarr and Sonarr instances defined above and adds them as Jellyfin tags.<br/><strong>Note:</strong> Run the sync task from Dashboard &gt; Scheduled Tasks &gt; "Sync Tags from *arr to Jellyfin" and configure how often it should run.' },
            { id: 'arrTagsPrefix', prop: 'ArrTagsPrefix', type: 'text', default: 'Requested by: ', label: 'Tag Prefix', placeholder: 'JE Arr Tag: ',
              desc: 'Prefix to add before each tag (e.g., "JE Arr Tag: " will result in "JE Arr Tag: 1 - Jellyfish")' },
            { id: 'arrTagsClearOldTags', prop: 'ArrTagsClearOldTags', type: 'toggle', default: true, label: 'Clear old tags before sync',
              desc: 'When enabled, removes all existing tags starting with the prefix before adding new ones. This keeps tags in sync with your *arr applications.' },
            { id: 'arrTagsShowAsLinks', prop: 'ArrTagsShowAsLinks', type: 'toggle', default: true, label: 'Show synced tags as links',
              desc: 'Displays tags with the configured prefix as clickable links on item detail pages. Helpful if your theme hides tags.' },
            { type: 'group', title: 'Tag Filters', items: [
                { id: 'arrTagsSyncFilter', prop: 'ArrTagsSyncFilter', type: 'textarea', rows: 3, label: 'Sync to Jellyfin Filter', placeholder: 'One per line',
                  desc: 'Only sync specific tags from *arr to Jellyfin. Enter one tag name per line (without the prefix).<br/>Leave empty to sync all tags.<br/><strong>Example:</strong> to only sync "1 - Jellyfish" and "trakt", enter:<br/><code>1 - Jellyfish</code><br/><code>trakt</code>' },
                { id: 'arrTagsLinksFilter', prop: 'ArrTagsLinksFilter', type: 'textarea', rows: 3, label: 'Show as Links Filter', placeholder: 'One per line',
                  desc: 'Only show specific tags as links. Enter one tag name per line (without the prefix).<br/>Leave empty to show all tags with the prefix.<br/><strong>Example:</strong> to only show "JE Arr Tag: 1 - Jellyfish" and "JE Arr Tag: trakt" as links, enter:<br/><code>1 - Jellyfish</code><br/><code>trakt</code>' },
                { id: 'arrTagsLinksHideFilter', prop: 'ArrTagsLinksHideFilter', type: 'textarea', rows: 3, label: 'Hide Specific Links Filter', placeholder: 'One per line',
                  desc: 'Hide specific tags from being displayed as links. Enter one tag name per line (without the prefix).<br/>This filter takes priority over the "Show" filter above.<br/><strong>Example:</strong> to hide "JE Arr Tag: spam_tag" and "JE Arr Tag: test_tag", enter:<br/><code>spam_tag</code><br/><code>test_tag</code>' }
            ] }
        ]
    }
});
}
