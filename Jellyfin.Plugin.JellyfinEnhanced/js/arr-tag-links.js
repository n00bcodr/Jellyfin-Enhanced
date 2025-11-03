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

        let isAddingLinks = false; // Lock to prevent concurrent runs

        // Create a CSS-friendly slug from a tag name (without prefix)
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

        async function addTagLinks() {
            if (isAddingLinks) {
                return;
            }

            const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
            if (!visiblePage) return;

            const externalLinksContainer = visiblePage.querySelector('.itemExternalLinks');
            if (!externalLinksContainer) return;

            // Check if we already added links to this page
            if (externalLinksContainer.querySelector('.arr-tag-link')) {
                return;
            }

            isAddingLinks = true;
            try {
                const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                if (!itemId) return;

                const item = await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);
                if (!item?.Tags || item.Tags.length === 0) return;

                const tagPrefix = JE.pluginConfig.ArrTagsPrefix || 'Requested by: ';
                const tagsFilter = JE.pluginConfig.ArrTagsLinksFilter || '';

                // Parse filter list (one tag per line, without prefix)
                const allowedTags = tagsFilter
                    .split('\n')
                    .map(t => t.trim())
                    .filter(t => t.length > 0)
                    .map(t => `${tagPrefix}${t}`); // Add prefix to each filter entry

                // Filter tags that start with the prefix
                let relevantTags = item.Tags.filter(tag =>
                    tag.startsWith(tagPrefix)
                );

                // If filter is configured, only show tags in the filter list
                if (allowedTags.length > 0) {
                    relevantTags = relevantTags.filter(tag =>
                        allowedTags.some(allowed =>
                            tag.toLowerCase() === allowed.toLowerCase()
                        )
                    );
                }

                if (relevantTags.length === 0) return;

                // Get server ID for the links
                const serverId = ApiClient.serverId();

                // Add each tag link individually to the external links container with spacing
                relevantTags.forEach(tag => {
                    externalLinksContainer.appendChild(document.createTextNode(' '));

                    const tagName = tag.slice(tagPrefix.length).trim();
                    const slug = slugifyTagName(tagName);

                    const link = document.createElement('a');
                    link.setAttribute('is', 'emby-linkbutton');
                    link.className = 'button-link emby-button arr-tag-link';
                    link.href = `#!/list.html?type=tag&tag=${encodeURIComponent(tag)}&serverId=${serverId}`;
                    link.title = `View all items with tag: ${tag}`;
                    link.target = '_self';

                    // Data attributes to allow styling, hiding, and renaming via CSS
                    link.dataset.id = slug;              // e.g. (in)-netflix -> in-netflix
                    link.dataset.tag = tag;             // full tag with prefix
                    link.dataset.tagName = tagName;     // tag without prefix
                    link.dataset.tagPrefix = tagPrefix; // current prefix

                    // Build contents: icon + text span
                    const icon = document.createElement('span');
                    icon.className = 'arr-tag-link-icon';
                    icon.setAttribute('aria-hidden', 'true');
                    icon.textContent = '🏷️';

                    const text = document.createElement('span');
                    text.className = 'arr-tag-link-text';
                    // Mirror data attributes on text span for fine-grained CSS control
                    text.dataset.id = slug;
                    text.dataset.tag = tag;
                    text.dataset.tagName = tagName;
                    text.dataset.tagPrefix = tagPrefix;
                    text.textContent = ` ${tag}`; // leading space after icon for spacing

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

        // Cleanup function to remove stale links from hidden pages
        function cleanupStaleLinks() {
            document.querySelectorAll('#itemDetailPage.hide .arr-tag-link').forEach(staleLink => {
                if (staleLink.previousSibling && staleLink.previousSibling.nodeType === Node.TEXT_NODE) {
                    staleLink.previousSibling.remove();
                }
                staleLink.remove();
            });
        }

        // Run periodically
        setInterval(() => {
            cleanupStaleLinks();
            addTagLinks();
        }, 500);

        console.log(`${logPrefix} Initialized successfully`);
    };
})(window.JellyfinEnhanced);
