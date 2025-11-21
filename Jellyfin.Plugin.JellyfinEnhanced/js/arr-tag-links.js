// /js/arr-tag-links.js
(function (JE) {
    'use strict';

    JE.initializeArrTagLinksScript = async function () {
        const logPrefix = '🪼 Jellyfin Enhanced: Arr Tag Links:';

        if (!JE?.pluginConfig?.ArrTagsShowAsLinks) {
            console.log(`${logPrefix} Tag links display disabled in plugin settings.`);
            return;
        }

        console.log(`${logPrefix} Initializing...`);

        let isAddingLinks = false;

        function slugifyTagName(name) {
            try {
                return name
                    .toString()
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .toLowerCase()
                    .trim()
                    .replace(/\s+/g, '-')
                    .replace(/[^a-z0-9-_]/g, '-')
                    .replace(/--+/g, '-')
                    .replace(/^-+|-+$/g, '');
            } catch {
                return name;
            }
        }

        async function addTagLinks(itemId, externalLinksContainer) {
            if (isAddingLinks) {
                return;
            }

            // Check if already rendered for this itemId
            const existing = externalLinksContainer.querySelector('.arr-tag-link');
            if (existing && existing.dataset.itemId === itemId) {
                return;
            }

            // Remove old links if switching items
            externalLinksContainer.querySelectorAll('.arr-tag-link').forEach(link => {
                if (link.previousSibling && link.previousSibling.nodeType === Node.TEXT_NODE) {
                    link.previousSibling.remove();
                }
                link.remove();
            });

            isAddingLinks = true;
            try {
                const item = await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);

                if (!item?.Tags || item.Tags.length === 0) return;

                const tagPrefix = JE.pluginConfig.ArrTagsPrefix || 'JE Arr Tag: ';
                const tagsFilter = JE.pluginConfig.ArrTagsLinksFilter || '';
                const tagsHideFilter = JE.pluginConfig.ArrTagsLinksHideFilter || '';

                const allowedTags = tagsFilter
                    .split('\n')
                    .map(t => t.trim())
                    .filter(t => t.length > 0)
                    .map(t => `${tagPrefix}${t}`);

                const hiddenTags = tagsHideFilter
                    .split('\n')
                    .map(t => t.trim())
                    .filter(t => t.length > 0)
                    .map(t => `${tagPrefix}${t}`);

                let relevantTags = item.Tags.filter(tag =>
                    tag.startsWith(tagPrefix)
                );

                if (hiddenTags.length > 0) {
                    relevantTags = relevantTags.filter(tag =>
                        !hiddenTags.some(hidden =>
                            tag.toLowerCase() === hidden.toLowerCase()
                        )
                    );
                }

                if (allowedTags.length > 0) {
                    relevantTags = relevantTags.filter(tag =>
                        allowedTags.some(allowed =>
                            tag.toLowerCase() === allowed.toLowerCase()
                        )
                    );
                }

                if (relevantTags.length === 0) return;

                const serverId = ApiClient.serverId();

                relevantTags.forEach(tag => {
                    externalLinksContainer.appendChild(document.createTextNode(' '));

                    const tagName = tag.slice(tagPrefix.length).trim();
                    const slug = slugifyTagName(tagName);

                    const link = document.createElement('a');
                    link.setAttribute('is', 'emby-linkbutton');
                    link.className = 'button-link emby-button arr-tag-link';
                    link.href = `#!/list.html?type=tag&tag=${encodeURIComponent(tag)}&serverId=${serverId}`;
                    link.title = `View all items with tag: ${tag}`;

                    link.addEventListener('click', (e) => {
                        e.preventDefault();
                        const url = `list.html?type=tag&tag=${encodeURIComponent(tag)}&serverId=${serverId}`;
                        if (window.Dashboard && typeof window.Dashboard.navigate === 'function') {
                            window.Dashboard.navigate(url);
                        } else {
                            window.location.hash = `!/${url}`;
                        }
                    });

                    link.dataset.itemId = itemId;
                    link.dataset.id = slug;
                    link.dataset.tag = tag;
                    link.dataset.tagName = tagName;
                    link.dataset.tagPrefix = tagPrefix;

                    const icon = document.createElement('span');
                    icon.className = 'arr-tag-link-icon';
                    icon.setAttribute('aria-hidden', 'true');
                    icon.textContent = '🏷️';
                    icon.style.marginRight = '5px';

                    const text = document.createElement('span');
                    text.className = 'arr-tag-link-text';
                    text.dataset.id = slug;
                    text.dataset.tag = tag;
                    text.dataset.tagName = tagName;
                    text.dataset.tagPrefix = tagPrefix;
                    text.textContent = tag;

                    link.appendChild(icon);
                    link.appendChild(text);

                    externalLinksContainer.appendChild(link);
                });

            } catch (err) {
                console.error(`${logPrefix} Error adding tag links:`, err);
            } finally {
                isAddingLinks = false;
            }
        }

        const observer = new MutationObserver((mutations) => {
            if (!JE?.pluginConfig?.ArrTagsShowAsLinks) {
                return;
            }

            for (const mutation of mutations) {
                if (mutation.type === 'childList' || mutation.type === 'attributes') {
                    const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
                    if (visiblePage) {
                        const externalLinksContainer = visiblePage.querySelector('.itemExternalLinks');
                        if (externalLinksContainer) {
                            try {
                                const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                                if (itemId) {
                                    addTagLinks(itemId, externalLinksContainer);
                                }
                            } catch (e) {
                                // Ignore URL parsing errors
                            }
                        }
                        break;
                    }
                }
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class']
        });

        console.log(`${logPrefix} Initialized successfully`);
    };
})(window.JellyfinEnhanced);
