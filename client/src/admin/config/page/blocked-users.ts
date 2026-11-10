import type { PageModules } from './modules';
import { asList, asObjects, text } from '../domain/config';
import { importPayload } from '../domain/seerr-import';
import { requestFailureWithBody } from '../domain/http';
import { asHtml, needControl, needHtml } from './dom';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type BlockedUsersDeps = Pick<PageModules, 'context' | 'save' | 'mediaTagsTab'>;

export function createBlockedUsers(m: BlockedUsersDeps) {
    const { ApiClient } = m.context;

        /**
         * Updates the blocked users count badge in the collapsible summary.
         */
        function updateBlockedUsersCount() : void {
            const total = document.querySelectorAll<HTMLElement>('.blockedUserCheckbox:checked').length;
            const countEl = asHtml(document.getElementById('blockedUsersCount'));
            if (countEl) {
                countEl.textContent = total > 0 ? '(' + total + ' blocked)' : '(none)';
            }
        }

        /**
         * Loads all Jellyfin users and renders a checkbox list for the blocklist.
         * Pre-checks users whose IDs appear in the saved blocklist config.
         * @param {string} blockedIdsString - Comma-separated dashless user IDs to pre-select.
         */
        // Tracks whether the most recent loadBlockedUsersList successfully rendered
        // checkboxes. If /Users API fails, syncBlockedUsersToHiddenInput must not
        // run — otherwise it would wipe the entire blocklist on save.
        let _blockedUsersLoaded = false;

        async function loadBlockedUsersList(blockedIdsString: string) : Promise<void> {
            const container = needHtml(document.getElementById('blockedUsersContainer'));
            const blockedSet = new Set(
                (blockedIdsString || '').split(/[,\r\n]+/).map(id => id.trim().replace(/-/g, '').toLowerCase()).filter(Boolean)
            );

            _blockedUsersLoaded = false;
            try {
                const users = asObjects(await ApiClient.getUsers());
                container.textContent = '';
                users.sort((a, b) => text(a.Name).localeCompare(text(b.Name)));
                users.forEach(user => {
                    const normalizedId = text(user.Id).replace(/-/g, '').toLowerCase();
                    const div = document.createElement('div');
                    div.className = 'checkboxContainer';
                    div.style.marginBottom = '0.3em';

                    const label = document.createElement('label');
                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.className = 'blockedUserCheckbox jea-switch';
                    label.className = 'jea-toggle';
                    checkbox.dataset.userid = normalizedId;
                    checkbox.checked = blockedSet.has(normalizedId);
                    checkbox.addEventListener('change', updateBlockedUsersCount);

                    const span = document.createElement('span');
                    span.textContent = text(user.Name);

                    label.appendChild(checkbox);
                    label.appendChild(span);
                    div.appendChild(label);
                    container.appendChild(div);
                });
                updateBlockedUsersCount();
                _blockedUsersLoaded = true;

                // Show scroll hint if content overflows, hide it once user scrolls to bottom
                const scrollHint = asHtml(document.getElementById('blockedUsersScrollHint'));
                if (scrollHint) {
                    const updateHint = () => {
                        const atBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 4;
                        scrollHint.style.display = (container.scrollHeight > container.clientHeight && !atBottom) ? 'block' : 'none';
                    };
                    // Check after render
                    requestAnimationFrame(updateHint);
                    container.addEventListener('scroll', updateHint);
                }
            } catch (e) {
                container.textContent = 'Could not load users.';
                console.error('Failed to load users for blocklist:', e);
                _blockedUsersLoaded = false;
            }
        }

        /**
         * Syncs checked blocked-user checkboxes into the hidden input for config save.
         * Skipped if loadBlockedUsersList failed — otherwise we'd wipe the whole
         * blocklist on save.
         */
        function syncBlockedUsersToHiddenInput() : void {
            if (!_blockedUsersLoaded) {
                console.warn('Jellyfin Enhanced: skipping blocklist sync — user list failed to load. Existing config preserved.');
                return;
            }
            const checkboxes = document.querySelectorAll<HTMLElement>('.blockedUserCheckbox:checked');
            const ids = Array.from(checkboxes).map(cb => cb.dataset.userid);
            needControl(document.querySelector('#jellyseerrImportBlockedUsers')).value = ids.join(',');
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
        needHtml(document.getElementById('btnImportJellyseerrUsers')).addEventListener('click', async () => {
            const btn = needControl(document.getElementById('btnImportJellyseerrUsers'));
            const resultDiv = needHtml(document.getElementById('importUsersResult'));
            // The import follows a finished save, outside its queue, so it holds its own scope.
            const scope = m.mediaTagsTab.jeWriteOrigin();
            btn.disabled = true;
            btn.textContent = 'Saving config...';
            resultDiv.style.display = 'none';

            try {
                // Save config first so the server uses the current blocklist
                await m.save.saveConfig(new Event('submit'));
            } catch (e) {
                if (!scope.isCurrent()) {
                    btn.disabled = false;
                    btn.textContent = 'Import Users Now';
                    return;
                }
                resultDiv.style.display = 'block';
                resultDiv.textContent = 'Could not save config. Import was not attempted.';
                resultDiv.style.color = '#f44336';
                console.error('Config save failed before import:', e);
                btn.disabled = false;
                btn.textContent = 'Import Users Now';
                return;
            }

            try {
                scope.throwIfStale();
                btn.textContent = 'Importing...';
                const response = await ApiClient.fetch({
                    url: ApiClient.getUrl('JellyfinEnhanced/jellyseerr/import-users'),
                    type: 'POST',
                    dataType: 'json'
                });

                // Handle different response shapes defensively (object, wrapped object, or JSON string)
                scope.throwIfStale();
                const payload = importPayload(response);

                const usersImported = Number(payload.usersImported);
                const totalUsers = Number(payload.totalUsers);
                const importedCount = Number.isFinite(usersImported) ? usersImported : 0;
                const totalCount = Number.isFinite(totalUsers) ? totalUsers : 0;
                const errors = asList(payload.errors);

                resultDiv.style.display = 'block';
                // surface backend errors[] so the admin sees WHY
                // partial imports failed (email collision, 401, etc.) instead
                // of a flat "Imported 0 new users" with no diagnosis.
                while (resultDiv.firstChild) resultDiv.removeChild(resultDiv.firstChild);
                const summary = document.createElement('div');
                summary.textContent = 'Imported ' + importedCount + ' new user(s) out of ' + totalCount + ' total.';
                summary.style.color = errors.length > 0 ? '#ff9800' : '#4caf50';
                resultDiv.appendChild(summary);
                if (errors.length > 0) {
                    const list = document.createElement('ul');
                    list.style.marginTop = '6px';
                    list.style.color = '#f44336';
                    list.style.fontSize = '0.9em';
                    for (const err of errors) {
                        const li = document.createElement('li');
                        li.textContent = String(err);
                        list.appendChild(li);
                    }
                    resultDiv.appendChild(list);
                }
            } catch (e) {
                if (!scope.isCurrent()) return;
                resultDiv.style.display = 'block';
                while (resultDiv.firstChild) resultDiv.removeChild(resultDiv.firstChild);
                const msg = document.createElement('div');
                msg.textContent = 'Import failed. Check Seerr configuration and API key permissions.';
                msg.style.color = '#f44336';
                resultDiv.appendChild(msg);
                // Show response.errors[] when the server returned 502 with structured errors.
                const detailErrors = asList((await requestFailureWithBody(e)).body?.errors);
                if (!scope.isCurrent()) return;
                if (detailErrors.length > 0) {
                    const list = document.createElement('ul');
                    list.style.marginTop = '6px';
                    list.style.color = '#f44336';
                    list.style.fontSize = '0.9em';
                    for (const err of detailErrors) {
                        const li = document.createElement('li');
                        li.textContent = String(err);
                        list.appendChild(li);
                    }
                    resultDiv.appendChild(list);
                }
                console.error('User import failed:', e);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Import Users Now';
            }
        });
    }

    return {
        wire,
        loadBlockedUsersList,
        syncBlockedUsersToHiddenInput,
    };
}
