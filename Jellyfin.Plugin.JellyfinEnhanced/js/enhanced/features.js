/**
 * @file Implements core, non-playback features for Jellyfin Enhanced.
 */
(function(JE) {
    'use strict';

    /**
     * Converts bytes into a human-readable format (e.g., KB, MB, GB).
     * @param {number} bytes The size in bytes.
     * @returns {string} The human-readable file size.
     */
    function formatSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        const formattedSize = parseFloat((bytes / Math.pow(k, i)).toFixed(2));
        return `${formattedSize} ${sizes[i]}`;
    }

    /**
     * Shows notifications using Jellyfin's built-in notification system.
     * @param {string} message The message to display.
     * @param {string} [type='info'] The type of notification ('info', 'error', 'success').
     */
    const showNotification = (message, type = 'info') => {
        try {
            if (window.Dashboard?.alert) {
                window.Dashboard.alert(message);
            } else if (window.Emby?.Notifications) {
                window.Emby.Notifications.show({ title: message, type: type, timeout: 3000 });
            } else {
                console.log(`🪼 Jellyfin Enhanced: Notification (${type}): ${message}`);
            }
        } catch (e) {
            console.error("🪼 Jellyfin Enhanced: Failed to show notification", e);
        }
    };

    /**
     * Fetches a random item (Movie or Series) from the user's library.
     * @returns {Promise<object|null>} A promise that resolves to a random item or null.
     */
    async function getRandomItem() {
        const userId = ApiClient.getCurrentUserId();
        if (!userId) {
            console.error("🪼 Jellyfin Enhanced: User not logged in.");
            return null;
        }

        const itemTypes = [];
        if (JE.currentSettings.randomIncludeMovies) itemTypes.push('Movie');
        if (JE.currentSettings.randomIncludeShows) itemTypes.push('Series');
        const includeItemTypes = itemTypes.join(',');

        let apiUrl = ApiClient.getUrl(`/Users/${userId}/Items?IncludeItemTypes=${includeItemTypes}&Recursive=true&SortBy=Random&Limit=20&Fields=ExternalUrls`);
        if (JE.currentSettings.randomUnwatchedOnly) {
            apiUrl += '&IsPlayed=false';
        }

        try {
            const response = await ApiClient.ajax({ type: 'GET', url: apiUrl, dataType: 'json' });
            if (response && response.Items && response.Items.length > 0) {
                const randomIndex = Math.floor(Math.random() * response.Items.length);
                return response.Items[randomIndex];
            }
            throw new Error('No items found in selected libraries.');
        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: Error fetching random item:', error);
            JE.toast(`❌ ${error.message || 'Unknown error'}`, 2000);
            return null;
        }
    }

    /**
     * Navigates the browser to the details page of the given item.
     * @param {object} item The item to navigate to.
     */
    function navigateToItem(item) {
        if (item && item.Id) {
            const serverId = ApiClient.serverId();
            const itemUrl = `#!/details?id=${item.Id}${serverId ? `&serverId=${serverId}` : ''}`;
            window.location.hash = itemUrl;
            JE.toast(JE.t('toast_random_item_loaded'), 2000);
        } else {
            console.error('🪼 Jellyfin Enhanced: Invalid item object or ID:', item);
            JE.toast(JE.t('toast_generic_error'), 2000);
        }
    }

    /**
     * Creates and injects the "Random" button into the page header if enabled.
     */
    JE.addRandomButton = () => {
        if (!JE.currentSettings.randomButtonEnabled) {
            document.getElementById('randomItemButtonContainer')?.remove();
            return;
        }

        if (document.getElementById('randomItemButton')) return;

        const buttonContainer = document.createElement('div');
        buttonContainer.id = 'randomItemButtonContainer';

        const randomButton = document.createElement('button');
        randomButton.id = 'randomItemButton';
        randomButton.setAttribute('is', 'paper-icon-button-light');
        randomButton.className = 'headerButton headerButtonRight paper-icon-button-light';
        randomButton.title = JE.t('random_button_tooltip');
        randomButton.innerHTML = `<i class="material-icons">casino</i>`;

        randomButton.addEventListener('click', async () => {
            randomButton.disabled = true;
            randomButton.classList.add('loading');
            randomButton.innerHTML = '<i class="material-icons">hourglass_empty</i>';

            try {
                const item = await getRandomItem();
                if (item) {
                    navigateToItem(item);
                }
            } finally {
                setTimeout(() => {
                    if (document.getElementById(randomButton.id)) {
                        randomButton.disabled = false;
                        randomButton.classList.remove('loading');
                        randomButton.innerHTML = `<i class="material-icons">casino</i>`;
                    }
                }, 500);
            }
        });

        buttonContainer.appendChild(randomButton);
        const headerRight = document.querySelector('.headerRight');
        headerRight?.prepend(buttonContainer);
    };

    /**
     * Shows the total file size of an item on its details page.
     * @param {string} itemId The ID of the item.
     */
    async function displayItemSize(itemId) {
        const targetSelector = '.itemMiscInfo.itemMiscInfo-primary';
        const container = document.querySelector(targetSelector);
        const existingTag = container?.querySelector('.mediaInfoItem-fileSize');

            if (existingTag && existingTag.dataset.itemId === itemId) {
                return;
            }
            if (existingTag) {
                existingTag.remove();
            }
            if (!container || container.classList.contains('fileSize-processing')) {
                return;
            }

        container.classList.add('fileSize-processing');

        try {
            const item = await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);
            if (item && item.MediaSources && item.MediaSources.length > 0) {
                const totalSize = item.MediaSources.reduce((sum, source) => sum + (source.Size || 0), 0);
                if (totalSize > 0 && !container.querySelector('.mediaInfoItem-fileSize')) {
                    const sizeElement = document.createElement('div');
                    sizeElement.className = 'mediaInfoItem mediaInfoItem-fileSize';
                    sizeElement.dataset.itemId = itemId;
                    sizeElement.title = JE.t('file_size_tooltip');
                    sizeElement.innerHTML = `<span class="material-icons" style="font-size: inherit; margin-right: 0.3em;">hard_disk</span>${formatSize(totalSize)}`;
                    container.appendChild(sizeElement);
                }
            }
        } catch (error) {
            console.error(`🪼 Jellyfin Enhanced: Error fetching item size for ID ${itemId}:`, error);
        } finally {
            container?.classList.remove('fileSize-processing');
        }
    }

    /**
     * Triggers the file size display check on details pages.
     */
    JE.runFileSizeCheck = () => {
        if (JE.currentSettings.showFileSizes && JE.isDetailsPage()) {
            try {
                const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                if (itemId) {
                    displayItemSize(itemId);
                }
            } catch (e) { /* ignore errors during page transitions */ }
        }
    };

    /**
     * A map of language names/codes to country codes for flag display.
     */
    const languageToCountryMap={English:"us",eng:"us",Japanese:"jp",jpn:"jp",Spanish:"es",spa:"es",French:"fr",fre:"fr",fra:"fr",German:"de",ger:"de",deu:"de",Italian:"it",ita:"it",Korean:"kr",kor:"kr",Chinese:"cn",chi:"cn",zho:"cn",Russian:"ru",rus:"ru",Portuguese:"pt",por:"pt",Hindi:"in",hin:"in",Dutch:"nl",dut:"nl",nld:"nl",Arabic:"sa",ara:"sa",Bengali:"bd",ben:"bd",Czech:"cz",ces:"cz",Danish:"dk",dan:"dk",Greek:"gr",ell:"gr",Finnish:"fi",fin:"fi",Hebrew:"il",heb:"il",Hungarian:"hu",hun:"hu",Indonesian:"id",ind:"id",Norwegian:"no",nor:"no",Polish:"pl",pol:"pl",Persian:"ir",per:"ir",fas:"ir",Romanian:"ro",ron:"ro",rum:"ro",Swedish:"se",swe:"se",Thai:"th",tha:"th",Turkish:"tr",tur:"tr",Ukrainian:"ua",ukr:"ua",Vietnamese:"vn",vie:"vn",Malay:"my",msa:"my",may:"my",Swahili:"ke",swa:"ke",Tagalog:"ph",tgl:"ph",Filipino:"ph",Tamil:"in",tam:"in",Telugu:"in",tel:"in",Marathi:"in",mar:"in",Punjabi:"in",pan:"in",Urdu:"pk",urd:"pk",Gujarati:"in",guj:"in",Kannada:"in",kan:"in",Malayalam:"in",mal:"in",Sinhala:"lk",sin:"lk",Nepali:"np",nep:"np",Pashto:"af",pus:"af",Kurdish:"iq",kur:"iq",Slovak:"sk",slk:"sk",Slovenian:"si",slv:"si",Serbian:"rs",srp:"rs",Croatian:"hr",hrv:"hr",Bulgarian:"bg",bul:"bg",Macedonian:"mk",mkd:"mk",Albanian:"al",sqi:"al",Estonian:"ee",est:"ee",Latvian:"lv",lav:"lv",Lithuanian:"lt",lit:"lt",Icelandic:"is",ice:"is",isl:"is",Georgian:"ge",kat:"ge",Armenian:"am",hye:"am",Mongolian:"mn",mon:"mn",Kazakh:"kz",kaz:"kz",Uzbek:"uz",uzb:"uz",Azerbaijani:"az",aze:"az",Belarusian:"by",bel:"by",Amharic:"et",amh:"et",Zulu:"za",zul:"za",Afrikaans:"za",afr:"za",Hausa:"ng",hau:"ng",Yoruba:"ng",yor:"ng",Igbo:"ng",ibo:"ng"};


    /**
     * Displays the audio languages of an item on its details page.
     * @param {string} itemId The ID of the item.
     */
    async function displayAudioLanguages(itemId) {
        const targetSelector = '.itemMiscInfo.itemMiscInfo-primary';
        const container = document.querySelector(targetSelector);

        const existingTag = container?.querySelector('.mediaInfoItem-audioLanguage');

        if (existingTag && existingTag.dataset.itemId === itemId) {
            return;
        }
        if (existingTag) {
            existingTag.remove();
        }
        if (!container || container.classList.contains('language-processing')) {
            return;
        }
        container.classList.add('language-processing');

        try {
            const item = await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);
            const languages = new Set();
            item?.MediaSources?.forEach(source => {
                source.MediaStreams?.filter(stream => stream.Type === 'Audio').forEach(stream => {
                    const langCode = stream.Language;
                    if (langCode && !['und', 'root'].includes(langCode.toLowerCase())) {
                        try {
                            const langName = new Intl.DisplayNames(['en'], { type: 'language' }).of(langCode);
                            languages.add(JSON.stringify({ name: langName, code: langCode }));
                        } catch (e) {
                            languages.add(JSON.stringify({ name: langCode.toUpperCase(), code: langCode }));
                        }
                    }
                });
            });

            const uniqueLanguages = Array.from(languages).map(JSON.parse);
            if (uniqueLanguages.length > 0) {
                const langElement = document.createElement('div');
                langElement.className = 'mediaInfoItem mediaInfoItem-audioLanguage';
                langElement.dataset.itemId = itemId;
                langElement.title = JE.t('audio_language_tooltip');
                langElement.style.display = 'flex';
                langElement.style.alignItems = 'center';
                langElement.innerHTML = `<span class="material-icons" style="font-size: inherit; margin-right: 0.3em;">translate</span>`;

                uniqueLanguages.forEach((lang, index) => {
                    const countryCode = languageToCountryMap[lang.name] || languageToCountryMap[lang.code];
                    if (countryCode) {
                        langElement.innerHTML += `<img src="https://flagcdn.com/w20/${countryCode.toLowerCase()}.png" alt="${lang.name} flag" style="width: 18px; margin-right: 0.3em; border-radius: 2px;">`;
                    }
                    langElement.appendChild(document.createTextNode(lang.name));
                    if (index < uniqueLanguages.length - 1) {
                        langElement.innerHTML += '<span style="margin: 0 0.25em;">, </span>';
                    }
                });
                container.appendChild(langElement);
            }
        } catch (error) {
            console.error(`🪼 Jellyfin Enhanced: Error fetching audio languages for ${itemId}:`, error);
        } finally {
            container?.classList.remove('language-processing');
        }
    }

    /**
     * Triggers the audio language display check on details pages.
     */
    JE.runLanguageCheck = () => {
        if (JE.currentSettings.showAudioLanguages && JE.isDetailsPage()) {
            try {
                const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                if (itemId) {
                    displayAudioLanguages(itemId);
                }
            } catch (e) { /* ignore */ }
        }
    };

    /**
     * Resets the playback position of an item to 0, effectively removing it from "Continue Watching".
     * @param {string} itemId The ID of the item to remove.
     * @returns {Promise<boolean>} A promise that resolves to true on success, false on failure.
     */
    async function removeFromContinueWatching(itemId) {
        const userId = ApiClient.getCurrentUserId();
        if (!userId || !itemId) {
            showNotification(JE.t('remove_continue_watching_error'), "error");
            return false;
        }

        try {
            await ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl(`/Users/${userId}/Items/${itemId}/UserData`),
                data: JSON.stringify({ PlaybackPositionTicks: 0 }),
                headers: { 'Content-Type': 'application/json' }
            });
            return true;
        } catch (error) {
            const errorMessage = error.responseJSON?.Message || error.statusText || JE.t('unknown_error');
            showNotification(JE.t('remove_continue_watching_error_api', { error: errorMessage }), "error");
            return false;
        }
    }

    /**
     * Creates the "Remove" button for the context menu action sheet.
     * @param {string} itemId The ID of the item.
     * @returns {HTMLElement} The created button element.
     */
    function createRemoveButton(itemId) {
        const button = document.createElement('button');
        button.setAttribute('is', 'emby-button');
        button.className = 'listItem listItem-button actionSheetMenuItem emby-button remove-continue-watching-button';
        button.dataset.id = 'remove-continue-watching';
        button.innerHTML = `
            <span class="actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons" aria-hidden="true">visibility_off</span>
            <div class="listItemBody actionsheetListItemBody"><div class="listItemBodyText actionSheetItemText">${JE.t('remove_button_text')}</div></div>
        `;

        button.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const buttonTextElem = button.querySelector('.actionSheetItemText');
            const buttonIconElem = button.querySelector('.material-icons');
            const originalText = buttonTextElem.textContent;
            const originalIcon = buttonIconElem.textContent;

            button.disabled = true;
            buttonTextElem.textContent = JE.t('remove_button_removing');
            buttonIconElem.textContent = 'hourglass_empty';

            const success = await removeFromContinueWatching(itemId);

            if (success) {
                document.querySelector('.actionSheet.opened')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                showNotification(JE.t('remove_continue_watching_success'), "success");
                setTimeout(() => window.Emby?.Page?.currentView?.refresh({ force: true }), 500);
            } else {
                button.disabled = false;
                buttonTextElem.textContent = originalText;
                buttonIconElem.textContent = originalIcon;
            }
        });

        return button;
    }

    /**
     * Adds the "Remove from Continue Watching" button to the action sheet if applicable.
     */
    JE.addRemoveButton = () => {
        if (!JE.currentSettings.removeContinueWatchingEnabled || !JE.state.isContinueWatchingContext) {
            return;
        }

        const actionSheetContent = document.querySelector('.actionSheetContent .actionSheetScroller');
        if (!actionSheetContent || actionSheetContent.querySelector('[data-id="remove-continue-watching"]')) {
            return;
        }

        const itemId = JE.state.currentContextItemId;
        if (!itemId) return;

        // Reset context flags after use
        JE.state.isContinueWatchingContext = false;
        JE.state.currentContextItemId = null;

        const removeButton = createRemoveButton(itemId);
        const insertionPoint = actionSheetContent.querySelector('[data-id="playallfromhere"]')
            || actionSheetContent.querySelector('[data-id="resume"]')
            || actionSheetContent.querySelector('[data-id="play"]');

        if (insertionPoint) {
            insertionPoint.after(removeButton);
        } else {
            actionSheetContent.appendChild(removeButton);
        }
    };

})(window.JellyfinEnhanced);