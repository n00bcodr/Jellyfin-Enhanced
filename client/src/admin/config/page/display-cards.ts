import { cdnUrl } from '../../../host/admin-config-host';
import type { PageModules } from './modules';
import { text } from '../domain/config';
import { asControl, asHtml, asInput, closestTo } from './dom';
import type { AdminConfig } from '../domain/config';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type DisplayCardsDeps = Pick<PageModules, 'context' | 'actions'>;

export function createDisplayCards(m: DisplayCardsDeps) {
    const { lifecycle } = m.context;

        // ==================== End Multi-Instance Arr Management ====================

        // Cache of the four "JE owns this Custom Tabs entry" booleans from the
        // most recently loaded config. Sync uses these to decide whether a
        // matching CT entry was created by JE (safe to delete) or by the admin
        // (must not touch). saveConfig writes the updated values back as part
        // of its single config write.
        var _jeCustomTabOwnedCache = Object.create(null);

        // The last loaded configuration, for the Media Tags card and the
        // Overview (Media Tags settings are edited on the Media Tags tab).
        var _jeMediaTagsConfig: AdminConfig | null = null;

        /**
         * Fill the Display tab's Media Tags card: tag types on for new users,
         * the default look and the server tag cache state.
         * @param {Object} config - The plugin configuration.
         */
        function renderMediaTagsCard(config: AdminConfig) : void {
            _jeMediaTagsConfig = config;
            const facts = asHtml(document.getElementById('jeMediaTagsCardFacts'));
            if (!facts) return;
            var names: Readonly<Record<string, string>> = { QualityTagsEnabled: 'Quality', GenreTagsEnabled: 'Genre', LanguageTagsEnabled: 'Language', RatingTagsEnabled: 'Rating', AgeRatingTagsEnabled: 'Age rating', StatusTagsEnabled: 'Status', AwardsTagsEnabled: 'Awards', LogoTagsEnabled: 'Logos', CustomTagsEnabled: 'Custom', PeopleTagsEnabled: 'People' };
            var on = Object.keys(names).filter(function (k) { return config[k] === true; }).map(function (k) { return names[k]; });
            var layout = String(config.TagLayout || 'corners').toLowerCase();
            var rows = [
                ['On for new users', on.length ? on.join(', ') : 'None'],
                ['Default look', layout.charAt(0).toUpperCase() + layout.slice(1) + ', ' + (String(config.TagLabelDensity || '').toLowerCase() === 'compact' ? 'compact' : 'full') + ' labels'],
                ['Server tag cache', config.TagCacheServerMode !== false ? 'On' : 'Off'],
                ['Native poster tags', config.NativePosterTagsEnabled === true ? 'On' : 'Off']
            ];
            facts.textContent = '';
            rows.forEach(function (row) {
                var dt = document.createElement('dt');
                dt.textContent = row[0] ?? '';
                var dd = document.createElement('dd');
                dd.textContent = row[1] ?? '';
                facts.appendChild(dt);
                facts.appendChild(dd);
            });
            m.actions.updateClearTagCachesQuickBtnVisibility();
        }

        // Updates the disabled/opacity styling on the up/down buttons so the
        // top row can't go up and the bottom row can't go down.
        function refreshQualityCatAdminArrows(container: Element) : void {
            var rows = container.querySelectorAll<HTMLElement>('.je-quality-cat-admin-row');
            rows.forEach(function (row, idx) {
                var up = asControl(row.querySelector('.je-cat-up'));
                var down = asControl(row.querySelector('.je-cat-down'));
                var first = idx === 0;
                var last = idx === rows.length - 1;
                if (up) {
                    up.disabled = first;
                    up.style.opacity = first ? '0.4' : '1';
                    up.style.cursor = first ? 'not-allowed' : 'pointer';
                }
                if (down) {
                    down.disabled = last;
                    down.style.opacity = last ? '0.4' : '1';
                    down.style.cursor = last ? 'not-allowed' : 'pointer';
                }
            });
        }

        // MDBList rating sources: key (matches the API's source string), display
        // label, and logo filename (served via the "mdblist-logos" CDN source,
        // see CdnAssetService.cs).
        var MDBLIST_SOURCES = [
            { key: 'tmdb', label: 'TMDB', logo: 'tmdb.png' },
            { key: 'tomatoes', label: 'RT Critic', logo: 'rottentomatoes.png' },
            { key: 'popcorn', label: 'RT Audience', logo: 'rottentomatoes_audience.png' },
            { key: 'imdb', label: 'IMDb', logo: 'imdb.png' },
            { key: 'trakt', label: 'Trakt', logo: 'trakt.png' },
            { key: 'metacritic', label: 'Metascore', logo: 'metacritic.png' },
            { key: 'metacriticuser', label: 'Metacritic User', logo: 'metacritic_audience.png' },
            { key: 'letterboxd', label: 'Letterboxd', logo: 'letterboxd.png' },
            { key: 'rogerebert', label: 'Roger Ebert', logo: 'rogerebert.png' },
            { key: 'myanimelist', label: 'MAL', logo: 'myanimelist.png' },
            { key: 'anilist', label: 'AniList', logo: 'anilist.png' },
            { key: 'master', label: 'Master', logo: 'master.png' },
        ];

        // Builds the checkbox+logo+reorder row list from the saved
        // MdblistRatingsSources comma string; empty means every source is
        // checked, in MDBLIST_SOURCES' built-in order. Rebuilt fresh on every
        // load (unlike the quality-category rows, which reorder fixed static
        // HTML) since the row set itself doesn't otherwise exist in the DOM.
        function renderMdblistSourcesAdmin(config: AdminConfig) : void {
            const container = asHtml(document.getElementById('mdblistRatingsSourcesAdmin'));
            if (!container) return;

            var configured = text(config.MdblistRatingsSources).split(',')
                .map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
            var knownKeys = MDBLIST_SOURCES.map(function (s) { return s.key; });
            var order = configured.length
                ? configured.filter(function (k) { return knownKeys.indexOf(k) !== -1; })
                : knownKeys.slice();
            // Any known source the admin's saved list doesn't mention (e.g. added
            // to MDBLIST_SOURCES after they last saved) still shows, unchecked if
            // the admin has an explicit (non-empty) list, checked otherwise.
            knownKeys.forEach(function (k) { if (order.indexOf(k) === -1) order.push(k); });

            container.innerHTML = '';
            order.forEach(function (key) {
                var meta = MDBLIST_SOURCES.filter(function (s) { return s.key === key; })[0];
                if (!meta) return;
                var checked = configured.length === 0 || configured.indexOf(key) !== -1;

                var row = document.createElement('div');
                row.className = 'je-quality-cat-admin-row';
                row.dataset.sourceKey = key;

                var checkboxContainer = document.createElement('div');
                checkboxContainer.className = 'checkboxContainer';
                var label = document.createElement('label');
                var checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'je-mdblist-source-toggle';
                checkbox.checked = checked;
                var img = document.createElement('img');
                img.src = cdnUrl('mdblist-logos/' + meta.logo);
                img.alt = '';
                img.style.cssText = 'height:16px;vertical-align:middle;margin:0 8px;';
                var span = document.createElement('span');
                span.textContent = meta.label;
                label.appendChild(checkbox);
                label.appendChild(img);
                label.appendChild(span);
                checkboxContainer.appendChild(label);
                row.appendChild(checkboxContainer);

                var upBtn = document.createElement('button');
                upBtn.type = 'button';
                upBtn.className = 'jea-btn je-cat-up';
                upBtn.setAttribute('aria-label', 'Move up');
                upBtn.innerHTML = '<i class="material-icons" aria-hidden="true">arrow_upward</i>';
                var downBtn = document.createElement('button');
                downBtn.type = 'button';
                downBtn.className = 'jea-btn je-cat-down';
                downBtn.setAttribute('aria-label', 'Move down');
                downBtn.innerHTML = '<i class="material-icons" aria-hidden="true">arrow_downward</i>';
                row.appendChild(upBtn);
                row.appendChild(downBtn);

                container.appendChild(row);
            });
            refreshQualityCatAdminArrows(container);
        }

        // Reads the current row order + checked state back into the
        // comma-separated MdblistRatingsSources string at save time.
        function computeMdblistRatingsSources() : string {
            var container = asHtml(document.getElementById('mdblistRatingsSourcesAdmin'));
            if (!container) return '';
            var rows = Array.from(container.querySelectorAll<HTMLElement>('.je-quality-cat-admin-row'));
            return rows.filter(function (row) {
                var cb = asInput(row.querySelector('.je-mdblist-source-toggle'));
                return cb && cb.checked;
            }).map(function (row) { return row.dataset.sourceKey; }).join(',');
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
        // Wire up/down arrow clicks for the MDBList sources list (delegated,
        // mirrors the quality-category handler above -- reuses the same
        // refreshQualityCatAdminArrows for the disabled-at-the-ends styling).
        (function () {
            document.addEventListener('click', function (e) {
                var btn = closestTo(e, '#mdblistRatingsSourcesAdmin .je-cat-up, #mdblistRatingsSourcesAdmin .je-cat-down');
                if (!(btn instanceof HTMLButtonElement) || btn.disabled) return;
                e.preventDefault();
                var row = btn.closest('.je-quality-cat-admin-row');
                if (!row) return;
                var parent = row.parentNode;
                if (!parent) return;
                var isUp = btn.classList.contains('je-cat-up');
                var sibling = isUp ? row.previousElementSibling : row.nextElementSibling;
                if (!sibling || !sibling.classList.contains('je-quality-cat-admin-row')) return;
                if (isUp) { parent.insertBefore(row, sibling); } else { parent.insertBefore(sibling, row); }
                if (parent instanceof Element) refreshQualityCatAdminArrows(parent);
            }, { signal: lifecycle.signal });
        })();
    }

    return {
        wire,
        _jeCustomTabOwnedCache,
        get _jeMediaTagsConfig() { return _jeMediaTagsConfig; },
        set _jeMediaTagsConfig(value) { _jeMediaTagsConfig = value; },
        computeMdblistRatingsSources,
        renderMdblistSourcesAdmin,
        renderMediaTagsCard,
    };
}
