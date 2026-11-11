import type { PageModules } from './modules';
import { asObject, asObjects, shown } from '../domain/config';
import { asControl, asHtml, asSelect, needSelect } from './dom';
import type { AdminConfig } from '../domain/config';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type AutoMovieDeps = Pick<PageModules, 'context' | 'load'>;

export function createAutoMovie(m: AutoMovieDeps) {
    const { ApiClient } = m.context;

        // Auto Movie Request - Quality Profile Mode helpers
        function clearSelectOptions(selectEl: HTMLSelectElement) : void {
            while (selectEl.options.length > 0) {
                selectEl.remove(0);
            }
        }

        function addSelectOption(selectEl: HTMLSelectElement, value: string, text: string) : void {
            var opt = document.createElement('option');
            opt.value = value;
            opt.textContent = text;
            selectEl.appendChild(opt);
        }

        function resetSelectWithMessage(selectEl: HTMLSelectElement, value: string, message: string) : void {
            clearSelectOptions(selectEl);
            addSelectOption(selectEl, value, message);
            // A placeholder, not a choice from Seerr's list: a save keeps the stored value (save.ts).
            delete selectEl.dataset.jeLoaded;
        }

        function initAutoMovieQualityMode() : void {
            const qualityModeSelect = asControl(document.querySelector('#autoMovieRequestQualityMode'));
            const customSettingsDiv = asHtml(document.querySelector('#autoMovieRequestCustomSettings'));
            if (!qualityModeSelect || !customSettingsDiv) return;

            qualityModeSelect.addEventListener('change', function() {
                customSettingsDiv.style.display = (qualityModeSelect.value === 'custom') ? 'block' : 'none';
                if (qualityModeSelect.value === 'custom') {
                    // Show the stored server, profile and folder, as a page loaded in Custom mode does.
                    loadAutoMovieRadarrServers(m.load.formBase);
                }
            });
        }

        var _autoMovieServerListenerAdded = false;

        function loadAutoMovieRadarrServers(savedConfig?: AdminConfig) : void {
            const serverSelect = asSelect(document.querySelector('#autoMovieRequestServer'));
            var profileSelect = needSelect(document.querySelector('#autoMovieRequestProfile'));
            var folderSelect = needSelect(document.querySelector('#autoMovieRequestRootFolder'));
            if (!serverSelect) return;

            resetSelectWithMessage(serverSelect, '-1', 'Loading...');

            ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinEnhanced/jellyseerr/radarr'),
                dataType: 'json'
            }).then(function(servers) {
                resetSelectWithMessage(serverSelect, '-1', 'Select Server...');
                var serverList = Array.isArray(servers) ? servers : [servers];
                serverList.forEach(function(server) {
                    if (server && typeof server.id === 'number') {
                        addSelectOption(serverSelect, shown(server.id), (shown(server.name) || ('Server ' + shown(server.id))) + (server.is4k ? ' (4K)' : ''));
                    }
                });

                var savedServerId = savedConfig ? savedConfig.AutoMovieRequestCustomServerId : null;
                if (typeof savedServerId === 'number' && savedServerId >= 0) {
                    serverSelect.value = String(savedServerId);
                    loadAutoMovieServerDetails(String(savedServerId), savedConfig);
                }
                serverSelect.dataset.jeLoaded = 'true';
            }).catch(function(err) {
                resetSelectWithMessage(serverSelect, '-1', 'Failed to load servers');
                console.warn('[Auto-Movie-Request] Failed to load Radarr servers:', err);
            });

            if (!_autoMovieServerListenerAdded) {
                _autoMovieServerListenerAdded = true;
                serverSelect.addEventListener('change', function() {
                    var serverId = parseInt(serverSelect.value);
                    if (!isNaN(serverId) && serverId >= 0) {
                        loadAutoMovieServerDetails(String(serverId));
                    } else {
                        resetSelectWithMessage(profileSelect, '0', 'Select a server first...');
                        resetSelectWithMessage(folderSelect, '', 'Select a server first...');
                    }
                });
            }
        }

        function loadAutoMovieServerDetails(serverId: string, savedConfig?: AdminConfig) : void {
            const profileSelect = asSelect(document.querySelector('#autoMovieRequestProfile'));
            const folderSelect = asSelect(document.querySelector('#autoMovieRequestRootFolder'));
            if (!profileSelect || !folderSelect) return;

            resetSelectWithMessage(profileSelect, '0', 'Loading...');
            resetSelectWithMessage(folderSelect, '', 'Loading...');

            ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinEnhanced/jellyseerr/radarr/' + serverId),
                dataType: 'json'
            }).then(function(details) {
                resetSelectWithMessage(profileSelect, '0', 'Select Profile...');
                asObjects(asObject(details).profiles).forEach(function(profile) {
                    addSelectOption(profileSelect, shown(profile.id), shown(profile.name) || ('Profile ' + shown(profile.id)));
                });

                resetSelectWithMessage(folderSelect, '', 'Select Folder...');
                asObjects(asObject(details).rootFolders).forEach(function(folder) {
                    addSelectOption(folderSelect, shown(folder.path), shown(folder.path));
                });

                var savedProfileId = (savedConfig && savedConfig.AutoMovieRequestCustomProfileId) || 0;
                if (typeof savedProfileId === 'number' && savedProfileId > 0) profileSelect.value = String(savedProfileId);
                var savedRootFolder = (savedConfig && savedConfig.AutoMovieRequestCustomRootFolder) || '';
                if (savedRootFolder) folderSelect.value = shown(savedRootFolder);
                profileSelect.dataset.jeLoaded = folderSelect.dataset.jeLoaded = 'true';
            }).catch(function(err) {
                resetSelectWithMessage(profileSelect, '0', 'Failed to load');
                resetSelectWithMessage(folderSelect, '', 'Failed to load');
                console.warn('[Auto-Movie-Request] Failed to load server details:', err);
            });
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {

    }

    return {
        wire,
        initAutoMovieQualityMode,
        loadAutoMovieRadarrServers,
    };
}
