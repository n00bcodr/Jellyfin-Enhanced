/**
 * @file Manages the one-time migration of settings from localStorage to the server.
 */
(function(JE) {
    'use strict';

    function hasLocalStorageData() {
        return localStorage.getItem('jellyfinEnhancedSettings') || localStorage.getItem('jellyfinEnhancedUserShortcuts') || localStorage.getItem('streaming-settings');
    }

    function getLocalStorageData() {
        const settings = JSON.parse(localStorage.getItem('jellyfinEnhancedSettings') || '{}');
        const shortcuts = JSON.parse(localStorage.getItem('jellyfinEnhancedUserShortcuts') || '{}');
        const elsewhere = JSON.parse(localStorage.getItem('streaming-settings') || '{}');
        const bookmarks = JSON.parse(localStorage.getItem('jellyfinEnhancedBookmarks') || '{}');

        return { settings, shortcuts, elsewhere, bookmarks };
    }

    function clearLocalStorage() {
        localStorage.removeItem('jellyfinEnhancedSettings');
        localStorage.removeItem('jellyfinEnhancedUserShortcuts');
        localStorage.removeItem('streaming-settings');
        localStorage.removeItem('jellyfinEnhancedBookmarks');
        localStorage.removeItem('jellyfinEnhancedLastCleared');
        localStorage.removeItem('jellyfinEnhancedLastAdminReset');
        alert('Local browser settings have been cleared. The page will now reload.');
        window.location.reload();
    }

    function createMigrationContainer() {
        const container = document.createElement('div');
        container.id = 'migration-container';
        container.style.cssText = `
            padding: 10px 20px;
            background: rgba(0,0,0,0.2);
            border-bottom: 1px solid rgba(255,255,255,0.1);
        `;

        const infoText = document.createElement('p');
        infoText.innerHTML = "Settings from a previous version were found in this browser's local storage.";
        infoText.style.cssText = 'font-size: 13px; text-align: center; margin: 0 0 10px 0; color: rgba(255,255,255,0.7);';

        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; gap: 10px; justify-content: center;';

        const migrateButton = document.createElement('button');
        migrateButton.id = 'migrateSettingsBtn';
        migrateButton.innerHTML = `
            <i class="material-icons" style="font-size: 16px; margin-right: 6px;">upload</i>
            <span>Migrate Settings</span>
        `;
        migrateButton.style.cssText = `
            font-family: inherit; background: #4CAF50; color: white; border: none;
            padding: 8px 12px; border-radius: 6px; font-size: 12px; font-weight: 600;
            cursor: pointer; transition: all 0.2s; display: flex; align-items: center;
        `;
        migrateButton.onmouseover = () => migrateButton.style.background = '#66BB6A';
        migrateButton.onmouseout = () => migrateButton.style.background = '#4CAF50';

        const clearButton = document.createElement('button');
        clearButton.id = 'clearLocalSettingsBtn';
        clearButton.innerHTML = `
             <i class="material-icons" style="font-size: 16px; margin-right: 6px;">delete_sweep</i>
            <span>Clear Local Data</span>
        `;
        clearButton.style.cssText = `
            font-family: inherit; background: #f44336; color: white; border: none;
            padding: 8px 12px; border-radius: 6px; font-size: 12px; font-weight: 600;
            cursor: pointer; transition: all 0.2s; display: flex; align-items: center;
        `;
        clearButton.onmouseover = () => clearButton.style.background = '#E57373';
        clearButton.onmouseout = () => clearButton.style.background = '#f44336';


        migrateButton.addEventListener('click', async () => {
            if (!confirm('This will overwrite your current server-side settings with the settings stored in this browser. Do you want to continue?')) {
                return;
            }

            const localData = getLocalStorageData();

            // --- Prepare UserSettings ---
            const userSettings = {
                ...JE.currentSettings, // Start with current server settings/defaults
                ...localData.settings // Overwrite with local settings
            };
            // Clean up properties that belong in other files
            ['Shortcuts', 'Bookmarks', 'ElsewhereRegion', 'ElsewhereRegions', 'ElsewhereServices'].forEach(key => delete userSettings[key]);


            // --- Prepare UserShortcuts ---
            const userShortcuts = { Shortcuts: [] };
            for (const [name, key] of Object.entries(localData.shortcuts)) {
                const defaultConfig = JE.pluginConfig.Shortcuts.find(s => s.Name === name);
                if (defaultConfig) {
                    userShortcuts.Shortcuts.push({ ...defaultConfig, Key: key });
                }
            }

            // --- Prepare ElsewhereSettings ---
            const elsewhereSettings = {
                Region: localData.elsewhere.region || '',
                Regions: localData.elsewhere.regions || [],
                Services: localData.elsewhere.services || []
            };

            // --- Prepare Bookmarks ---
            const userBookmarks = {
                Bookmarks: localData.bookmarks || {}
            };

            // --- Save all settings to server ---
            await Promise.all([
                JE.saveUserSettings('settings.json', userSettings),
                JE.saveUserSettings('shortcuts.json', userShortcuts),
                JE.saveUserSettings('elsewhere.json', elsewhereSettings),
                JE.saveUserSettings('bookmarks.json', userBookmarks)
            ]);

            clearLocalStorage();
        });

        clearButton.addEventListener('click', () => {
             if (!confirm('Are you sure you want to permanently delete the old settings from this browser? This cannot be undone.')) {
                return;
            }
            clearLocalStorage();
        });

        buttonContainer.appendChild(migrateButton);
        buttonContainer.appendChild(clearButton);
        container.appendChild(infoText);
        container.appendChild(buttonContainer);
        return container;
    }

    JE.initializeMigration = function() {
        if (!hasLocalStorageData()) {
            return;
        }

        // This function will be called by ui.js when the panel is created
        JE.addMigrationButton = function(panel) {
            const header = panel.querySelector('div[style*="padding: 18px 20px"]');
            if (header) {
                const migrationContainer = createMigrationContainer();
                header.parentNode.insertBefore(migrationContainer, header.nextSibling);
            }
        };
    };

})(window.JellyfinEnhanced);