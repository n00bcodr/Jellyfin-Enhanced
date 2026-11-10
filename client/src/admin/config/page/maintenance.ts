import type { PageModules } from './modules';
import { asObject, asObjects, shown } from '../domain/config';
import { asHtml, needControl, needHtml } from './dom';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type MaintenanceDeps = Pick<PageModules, 'context'>;

export function createMaintenance(m: MaintenanceDeps) {
    const { ApiClient } = m.context;

        // ── Maintenance mode: user checklist ─────────────────────────────────────

        function loadMaintenanceUsers() : void {
            ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinEnhanced/MaintenanceMode/Users'),
                dataType: 'json'
            }).then(function(users) {
                const inner = asHtml(document.getElementById('je-mm-users-inner'));
                if (!inner) return;
                inner.innerHTML = '';

                const list = asObjects(users);
                if (list.length === 0) {
                    const msg = document.createElement('div');
                    msg.style.cssText = 'opacity:0.55;font-size:0.875em;';
                    msg.textContent = 'No non-admin users found.';
                    inner.appendChild(msg);
                    return;
                }

                // Collect any pre-selected IDs stored on the container by loadConfig
                const listEl = needHtml(document.getElementById('je-mm-user-list'));
                let preselect = [];
                try { preselect = JSON.parse(listEl.dataset.preselect || '[]'); } catch (e) {}
                const preselectAll = preselect.length === 0;

                // 3-column grid
                const grid = document.createElement('div');
                grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:0.2em 0.75em;';

                list.forEach(function(u) {
                    // Handle both camelCase and PascalCase from the API
                    const uid  = shown(u.id)  || shown(u.Id)  || '';
                    const uname = shown(u.username) || shown(u.Username) || uid;

                    const checked = preselectAll || preselect.indexOf(uid) !== -1;

                    const label = document.createElement('label');
                    label.style.cssText = 'display:flex;align-items:center;gap:0.45em;padding:0.3em 0.2em;cursor:pointer;border-radius:4px;min-width:0;';

                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.className = 'je-mm-user-cb';
                    cb.value = uid;
                    cb.checked = checked;
                    cb.style.flexShrink = '0';

                    const avatar = document.createElement('span');
                    avatar.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;' +
                        'width:26px;height:26px;border-radius:50%;background:rgba(255,255,255,0.15);' +
                        'font-size:0.7em;font-weight:700;flex-shrink:0;overflow:hidden;';
                    const fallbackLetter = document.createTextNode((uname || '?').charAt(0).toUpperCase());
                    // Users without a profile picture get the letter straight
                    // away instead of an image request that can only 404 (an
                    // older server omits hasImage: try the picture as before).
                    const hasImage = u.hasImage !== undefined ? u.hasImage : u.HasImage;
                    if (hasImage === false) {
                        avatar.appendChild(fallbackLetter);
                    } else {
                        // Try to load the user's actual Jellyfin profile picture
                        const img = document.createElement('img');
                        img.style.cssText = 'width:26px;height:26px;border-radius:50%;object-fit:cover;display:block;';
                        img.src = ApiClient.getUrl('/Users/' + uid + '/Images/Primary', { width: 26 });
                        img.alt = '';
                        img.onerror = function() {
                            img.style.display = 'none';
                            avatar.appendChild(fallbackLetter);
                        };
                        avatar.appendChild(img);
                    }

                    const name = document.createElement('span');
                    name.style.cssText = 'font-size:0.875em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                    name.textContent = uname;

                    label.appendChild(cb);
                    label.appendChild(avatar);
                    label.appendChild(name);
                    grid.appendChild(label);
                });

                inner.appendChild(grid);
            }).catch(function() {
                const inner = asHtml(document.getElementById('je-mm-users-inner'));
                if (!inner) return;
                inner.innerHTML = '';
                const msg = document.createElement('div');
                msg.style.cssText = 'opacity:0.55;font-size:0.875em;';
                msg.textContent = 'Failed to load users.';
                inner.appendChild(msg);
            });
        }

        /** Shows the inline warning when the daily window's start and end time are equal. */
        function updateMaintenanceScheduleWarning() : void {
            const start = needControl(document.getElementById('maintenanceScheduleStart')).value;
            const end = needControl(document.getElementById('maintenanceScheduleEnd')).value;
            needHtml(document.getElementById('mmScheduleSameTimeWarning')).style.display = start && start === end ? '' : 'none';
        }

        /**
         * Shows the server's current time under the daily window: the window runs on the server's
         * clock, which in containers is often UTC rather than the admin's time zone.
         */
        function refreshMaintenanceServerTime() : void {
            ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinEnhanced/MaintenanceMode/Status'),
                dataType: 'json'
            }).then(function(response) {
                const status = asObject(response);
                const el = asHtml(document.getElementById('mmServerTimeHint'));
                if (!el || !status || !status.ServerLocalTime) return;
                el.textContent = 'Server time is now ' + status.ServerLocalTime + ' (UTC' + status.ServerUtcOffset + '). Set the window in this time zone.';
            }).catch(function() { /* hint only */ });
        }

        function setupMaintenanceModeControls() : void {
            ['maintenanceScheduleStart', 'maintenanceScheduleEnd'].forEach(function(id) {
                needHtml(document.getElementById(id)).addEventListener('input', updateMaintenanceScheduleWarning);
            });

            // Show/hide user checklist based on radio selection
            document.querySelectorAll<HTMLInputElement>('input[name="maintenanceModeUsers"]').forEach(function(radio) {
                radio.addEventListener('change', function() {
                    const listEl = needHtml(document.getElementById('je-mm-user-list'));
                    if (radio.value === 'select') {
                        listEl.style.display = '';
                        loadMaintenanceUsers();
                    } else {
                        listEl.style.display = 'none';
                    }
                });
            });

            // Select All / Deselect All buttons
            needHtml(document.getElementById('je-mm-select-all')).addEventListener('click', function() {
                document.querySelectorAll<HTMLInputElement>('.je-mm-user-cb').forEach(function(cb) { cb.checked = true; });
            });
            needHtml(document.getElementById('je-mm-deselect-all')).addEventListener('click', function() {
                document.querySelectorAll<HTMLInputElement>('.je-mm-user-cb').forEach(function(cb) { cb.checked = false; });
            });
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
        setupMaintenanceModeControls();
    }

    return {
        wire,
        loadMaintenanceUsers,
        refreshMaintenanceServerTime,
        updateMaintenanceScheduleWarning,
    };
}
