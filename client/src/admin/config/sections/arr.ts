import type { DefineSections } from '../engine/schema';

/**
 * A KefinTweaks custom home section that reads the Leaving soon item list (GET leaving-soon/items, upstream
 * 6c922d10), as KefinTweaks' Import takes it.
 */
export const KEFIN_LEAVING_SOON_SECTION = JSON.stringify({
    id: 'leaving-soon', type: 'home', name: 'Leaving Soon', enabled: true, order: 72, cardFormat: 'Poster', userConfigurable: true,
    queries: [{ path: '/JellyfinEnhanced/leaving-soon/items', queryOptions: { Limit: 20 } }],
}, null, 2);

const KEFIN_COPY_LABEL = 'Copy KefinTweaks section';

/** What the Reclaimerr accounts made for Jellyfin users may do (the server's grantable permissions, never manage_users). */
const RECLAIMERR_NEW_PERMISSIONS: ReadonlyArray<readonly [string, string]> = [['request', 'Request removals'], ['auto_approve', 'Auto-approve'], ['manage_requests', 'Manage requests'], ['manage_protection', 'Manage protection'], ['manage_reclaim', 'Manage reclaim']];
/** The Reclaimerr pages those accounts can be given, in upstream's order. */
const RECLAIMERR_NEW_PAGES: readonly string[] = ['requests', 'candidates', 'settings', 'dashboard', 'movies', 'series', 'protected', 'duplicates', 'calendar', 'storage', 'history'];

/**
 * Copies {@link KEFIN_LEAVING_SOON_SECTION} on a click of the Leaving soon card's button (the engine forwards a click
 * on its Services tab copy here), then says "Copied" or "Copy failed" for two seconds.
 */
function wireKefinCopy(root: Document): void {
    const button = root.getElementById('leavingSoonCopyKefinBtn');
    if (!button || button.dataset.wired) return;
    button.dataset.wired = '1';
    const label = button.querySelector('span');
    const done = (ok: boolean): void => {
        if (!label) return;
        label.textContent = ok ? 'Copied' : 'Copy failed';
        setTimeout(() => { label.textContent = KEFIN_COPY_LABEL; }, 2000);
    };
    const legacy = (): void => {
        const area = root.createElement('textarea');
        area.value = KEFIN_LEAVING_SOON_SECTION;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        root.body.appendChild(area);
        area.select();
        let ok = false;
        try { ok = root.execCommand('copy'); } catch { ok = false; }
        area.remove();
        done(ok);
    };
    button.addEventListener('click', () => {
        const clipboard = root.defaultView?.navigator.clipboard;
        if (clipboard?.writeText) clipboard.writeText(KEFIN_LEAVING_SOON_SECTION).then(() => done(true), legacy);
        else legacy();
    });
}

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
    // Maintainerr and Reclaimerr (upstream da0ea773): the main form owns these fields (saved with the page's Save
    // button). Exactly one of the two is the removal tool: each card has a Use switch, turning one on turns the other
    // off (page/service-status.ts), and the settings of the one that is off are kept and collapse. The options both
    // share (the live state, the item menu, the home row, the refresh interval) are in the Leaving soon card. The cards
    // live here, the Services tab shows linked copies, and the Media Tags tab (Status badges > Leaving soon) shows the
    // live status and links here. The status line, Refresh now, Create service account and the Overview's Service Status
    // card are wired by page/service-status.ts. Setup cards (data-dep-setup), like Bazarr's and Shoko's: neither tool
    // needs Sonarr or Radarr here, so the tab's lock skips them.
    'arr-maintainerr': {
        title: 'Maintainerr', iconImg: 'selfhst/svg/maintainerr.svg', attrs: { 'data-dep-setup': '' },
        items: [
            { type: 'note', html: 'Maintainerr decides which items leave your library and when. Jellyfin Enhanced reads its collections for the <strong>Leaving soon</strong> tag and home row, and lets administrators <strong>mark, keep and postpone</strong> removals from an item\'s &#8942; menu. Set Maintainerr up first: the plugin never creates collections. It adds items to the <em>manual</em> collection you made for that library. The shared options are in the <strong>Leaving soon</strong> card.' },
            { id: 'LeavingSoonMaintainerrEnabled', prop: 'LeavingSoonMaintainerrEnabled', type: 'toggle', default: true, label: 'Use Maintainerr',
              desc: 'Only one of Maintainerr and Reclaimerr feeds <strong>Leaving soon</strong> and the item menu, so they never clash: turning one on turns the other off. The settings of the one that is off are kept.' },
            { id: 'LeavingSoonMaintainerrUrl', prop: 'LeavingSoonMaintainerrUrl', type: 'text', label: 'Maintainerr URL', placeholder: 'http://maintainerr:6246', showIf: 'LeavingSoonMaintainerrEnabled',
              desc: 'The address this server reaches Maintainerr at (<code>http://</code> or <code>https://</code>, no credentials or query). Redirects are not followed: use the final address. Empty turns the Maintainerr features off.' },
            { id: 'LeavingSoonMaintainerrApiKey', prop: 'LeavingSoonMaintainerrApiKey', type: 'text', label: 'Maintainerr API key', showIf: 'LeavingSoonMaintainerrEnabled',
              toConfig: (v) => String(v || '').trim(), fromConfig: (v) => String(v || '') }
        ]
    },
    'arr-reclaimerr': {
        title: 'Reclaimerr', iconImg: 'selfhst/svg/reclaimerr.svg', attrs: { 'data-dep-setup': '' },
        items: [
            { type: 'note', html: 'Reclaimerr decides which items leave your library, like Maintainerr. Jellyfin Enhanced reads its cleanup candidates and scheduled deletions for the <strong>Leaving soon</strong> tag and home row. Administrators can <strong>mark, keep and postpone</strong> from an item\'s &#8942; menu (pick an exact day), and any signed-in user can <strong>request a removal</strong>, which lands in Reclaimerr as a deletion request for an administrator to approve. The shared options are in the <strong>Leaving soon</strong> card.' },
            { id: 'ReclaimerrEnabled', prop: 'ReclaimerrEnabled', type: 'toggle', default: false, label: 'Use Reclaimerr',
              desc: 'Turning this on turns Maintainerr off (and the other way round). Its settings below are kept either way.' },
            { id: 'ReclaimerrUrl', prop: 'ReclaimerrUrl', type: 'text', label: 'Reclaimerr URL', placeholder: 'http://reclaimerr:8000', showIf: 'ReclaimerrEnabled',
              desc: 'The address this server reaches Reclaimerr at (<code>http://</code> or <code>https://</code>, no credentials or query). Redirects are not followed.' },
            { id: 'ReclaimerrApiKey', prop: 'ReclaimerrToken', type: 'text', label: 'Reclaimerr API token', showIf: 'ReclaimerrEnabled',
              toConfig: (v) => String(v || '').trim(), fromConfig: (v) => String(v || ''),
              desc: 'Create it in Reclaimerr under <em>Settings &gt; Integrations</em> with the candidates (manage), protections (manage), media (read) and system (read) scopes. Used for reading and for Keep and Postpone.' },
            { id: 'ReclaimerrActAsUser', prop: 'ReclaimerrActAsUser', type: 'toggle', default: true, label: 'Act as the Jellyfin user', showIf: 'ReclaimerrEnabled',
              desc: 'Requests and schedules carry the name of the Jellyfin user who made them (<strong>Request removal</strong>, <strong>Mark for removal</strong>, cancelling or moving a scheduled deletion), through Reclaimerr\'s trusted-proxy sign-in. Turn on <code>FORWARD_AUTH_ENABLED</code> in Reclaimerr with this server\'s address in <code>FORWARD_AUTH_TRUSTED_PROXIES</code>, and the user needs a Reclaimerr account: when they sign in to Reclaimerr with their Jellyfin login (media sign-in), Reclaimerr creates one (for example <code>sam_user</code>) and links it to them, and the plugin finds it through that link, so nothing has to be created or mapped by hand. Where that does not work, the service account below is used instead.' },
            { id: 'ReclaimerrUserHeader', prop: 'ReclaimerrUserHeader', type: 'text', default: 'Remote-User', label: 'User header', showIf: 'ReclaimerrActAsUser',
              toConfig: (v) => String(v || '').trim() || 'Remote-User',
              desc: 'The header Reclaimerr reads the user from: its <code>FORWARD_AUTH_USER_HEADER</code> (default <code>Remote-User</code>).' },
            { id: 'ReclaimerrUserMap', prop: 'ReclaimerrUserMap', type: 'textarea', rows: 3, placeholder: 'sam = samuel', label: 'Jellyfin user to Reclaimerr user', showIf: 'ReclaimerrActAsUser',
              toConfig: (v) => String(v || '').trim(),
              desc: 'Normally empty: the plugin finds each user\'s Reclaimerr account through the link Reclaimerr made when they signed in with Jellyfin (needs the service account to read it), else by the same name. List a user here only to point them at a different Reclaimerr account: one <code>Jellyfin name = Reclaimerr name</code> per line. This wins over the link.' },
            { id: 'ReclaimerrUsername', prop: 'ReclaimerrUsername', type: 'text', label: 'Service account username (fallback)', showIf: 'ReclaimerrEnabled',
              toConfig: (v) => String(v || '').trim(),
              desc: 'A dedicated Reclaimerr admin account, <strong>the fallback</strong> when the plugin cannot act as the user (Reclaimerr\'s trusted-proxy sign-in is off, or the user has no Reclaimerr account), and what reads scheduled deletions. Without acting as the user it is needed for <strong>Mark for removal</strong> and <strong>Request removal</strong>. Use <strong>Create service account</strong> below to make one (it asks for a Reclaimerr administrator\'s name, and a password only if their trusted sign-in is not available). Reading candidates, Keep and Postpone work with the token alone.' },
            { id: 'ReclaimerrPassword', prop: 'ReclaimerrPassword', type: 'text', label: 'Service account password (only for local login)', showIf: 'ReclaimerrEnabled',
              toConfig: (v) => String(v || ''), fromConfig: (v) => String(v || ''),
              desc: 'Optional. With <strong>Act as the Jellyfin user</strong> on and Reclaimerr\'s trusted-proxy sign-in working, the service account signs in by name alone, so this can stay empty (and Reclaimerr\'s local login can be switched off). It is used only when that does not work.' },
            { type: 'custom', showIf: 'ReclaimerrEnabled', html: '<div class="inputContainer jea-row"><button type="button" id="reclaimerrCreateAccountBtn" class="jea-btn">Create service account</button>'
                + '<div id="reclaimerrCreateAccountLine" class="jea-hint">Asks for a Reclaimerr administrator\'s name once (and a password only if their trusted sign-in is not available; not stored), creates a <code>jellyfin-enhanced</code> admin account with a random password and saves it here. Save the Reclaimerr URL first.</div></div>' },
            // Upstream 3ada0a4e. The boxes have no ids (they are not settings); page/service-status.ts keeps this card's two copies' ticks the same.
            { type: 'group', title: 'Create Reclaimerr accounts for Jellyfin users', open: true, showIf: 'ReclaimerrEnabled', items: [
                { type: 'note', html: 'Creates a Reclaimerr account for every Jellyfin user who has none, so each person\'s requests carry their own name and they can see them under <strong>My requests</strong>. They sign in through the trusted-proxy sign-in, so there is no password to know. Needs the service account above. Existing accounts are left as they are. Names shorter than 5 characters get <code>_user</code> added (Reclaimerr\'s minimum), and other characters become <code>_</code>.' },
                { type: 'custom', html: '<div class="inputContainer">'
                    + '<div><strong>What the new accounts may do</strong></div>'
                    + '<div id="reclaimerrNewPerms" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px 16px;margin:8px 0 16px">'
                    + RECLAIMERR_NEW_PERMISSIONS.map(([value, label]) => '<label><input type="checkbox" value="' + value + '"> ' + label + '</label>').join('') + '</div>'
                    + '<div><strong>Reclaimerr pages they can open</strong></div>'
                    + '<div id="reclaimerrNewPages" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px 16px;margin:8px 0 16px">'
                    + RECLAIMERR_NEW_PAGES.map(value => '<label><input type="checkbox" value="' + value + '"> ' + value.charAt(0).toUpperCase() + value.slice(1) + '</label>').join('') + '</div>'
                    + '<div class="jea-row"><button type="button" id="reclaimerrCreateUsersBtn" class="jea-btn">Create accounts for all Jellyfin users</button></div>'
                    + '<div id="reclaimerrCreateUsersLine" class="jea-hint"></div></div>' }
            ] }
        ]
    },
    // Shared by whichever removal tool is on: the live state, the item menu, the home row and the refresh interval.
    'arr-leaving-soon': {
        title: 'Leaving soon', icon: 'auto_delete', attrs: { 'data-dep-setup': '' },
        items: [
            { type: 'note', html: 'What the <strong>Leaving soon</strong> tag, the item menu and the home row use, whichever of Maintainerr and Reclaimerr is on. Turn one of them on in its card first.' },
            { type: 'custom', html: '<div class="inputContainer jea-row"><div class="je-api-row"><span id="maintainerrStatusIndicator" class="material-icons" aria-hidden="true"></span>'
                + '<button type="button" id="maintainerrRefreshBtn" class="jea-btn"><i class="material-icons" aria-hidden="true" style="font-size:1.1em;vertical-align:middle;margin-right:4px">refresh</i>Refresh now</button></div>'
                + '<div id="maintainerrStatusLine" class="jea-hint">&nbsp;</div><div id="maintainerrRowLine" class="jea-hint"></div>'
                + '<div class="jea-hint">Save first: Refresh uses the saved settings. Cards never ask the removal tool; the server reads it on the schedule below and keeps the answer in the tag cache.</div></div>' },
            { id: 'LeavingSoonMaintainerrActions', prop: 'LeavingSoonMaintainerrActions', type: 'toggle', default: true, label: 'Mark, keep and postpone from the item menu',
              desc: 'Administrators get <strong>Mark for removal</strong>, <strong>Keep</strong> and <strong>Postpone removal</strong> in a movie or series\' &#8942; menu (with Reclaimerr, each takes an exact day). Maintainerr: items are added to or removed from its existing manual collection for their library. Marking applies at once, with an Undo.' },
            { id: 'LeavingSoonHomeRow', prop: 'LeavingSoonHomeRow', type: 'toggle', default: true, label: 'Leaving soon home row',
              desc: 'A <strong>Leaving soon</strong> row on the <a class="sectionTitle" href="https://github.com/IAmParadox27/jellyfin-plugin-home-sections/" target="_blank" rel="noopener">Home Screen Sections</a> home page, soonest removal first. Needs the Home Screen Sections and File Transformation plugins. It is added enabled for everyone; users with their own section list can turn it on or off there.' },
            { type: 'custom', html: '<div class="inputContainer jea-row"><button type="button" id="leavingSoonCopyKefinBtn" class="jea-btn"><i class="material-icons" aria-hidden="true" style="font-size:1.1em;vertical-align:middle;margin-right:4px">content_copy</i><span>' + KEFIN_COPY_LABEL + '</span></button>'
                + '<div class="jea-hint">Copies a Leaving soon section for KefinTweaks. In KefinTweaks, open Enhanced Home Screen, New Section, Advanced, Import and paste it.</div></div>',
              init: wireKefinCopy },
            { id: 'LeavingSoonHideWatched', prop: 'LeavingSoonHideWatched', type: 'toggle', default: false, label: 'Hide watched titles in the home row',
              desc: 'Leaves out of the <strong>Leaving soon</strong> row what the user has already watched (a series counts once every episode is watched). Use this instead of the Hide Watched checkbox in Home Screen Sections, which that plugin keeps disabled for sections added by other plugins.' },
            { id: 'LeavingSoonRefreshHours', prop: 'LeavingSoonRefreshHours', type: 'number', min: 1, max: 168, default: 6, label: 'Refresh every (hours)',
              desc: 'How often the server reads the removal tool again (1&ndash;168 hours). A failed request is retried sooner. Each mark, keep or postpone reads it again at once.' }
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
            { id: 'arrTagsPrefix', prop: 'ArrTagsPrefix', type: 'text', default: 'JE Arr Tag: ', label: 'Tag Prefix', placeholder: 'JE Arr Tag: ',
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
