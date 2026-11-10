/** Links for the *arr-synced item tags ("JE Arr Tag: …") on item details. */
import { bridge, serverId } from './host';
import type { ArrTagLinksBridge } from './host';
import { hashItemId, lookupDetailsItem, sessionLease, visibleDetailPage } from './page';
import { navigateRoute, tagListRoute } from './links';
import { relevantArrTags, slugifyTagName } from './arr-domain';

const JE = bridge<ArrTagLinksBridge>('Arr tag links');

JE.initializeArrTagLinksScript = async function initializeArrTagLinksScript() {
    const logPrefix = '🪼 Jellyfin Enhanced: Arr Tag Links:';
    if (!JE.pluginConfig?.ArrTagsShowAsLinks) {
        console.log(`${logPrefix} Tag links display disabled in plugin settings.`);
        return;
    }
    console.log(`${logPrefix} Initializing...`);

    let isAddingLinks = false;
    // A scan that arrived while another was running runs once it finishes.
    let rescan = false;
    // Items known to have no relevant tags, for the signed-in account. Links
    // that were rendered are found in the DOM instead, so a re-rendered
    // external-links row (revisiting the item) gets them back.
    const withoutTags = new Set<string>();
    JE.session?.onUserChange('arr-tag-links', () => withoutTags.clear());

    function removeLinks(container: Element): void {
        container.querySelectorAll('.arr-tag-link').forEach(link => {
            if (link.previousSibling?.nodeType === Node.TEXT_NODE) link.previousSibling.remove();
            link.remove();
        });
    }

    async function addTagLinks(itemId: string, externalLinksContainer: Element): Promise<void> {
        if (isAddingLinks) {
            rescan = true;
            return;
        }
        // Already rendered for this item
        const existing = externalLinksContainer.querySelector<HTMLElement>('.arr-tag-link');
        if (existing && existing.dataset.itemId === itemId) return;
        // Another item's links (the view was reused)
        removeLinks(externalLinksContainer);
        if (withoutTags.has(itemId)) return;

        isAddingLinks = true;
        const session = sessionLease(JE.session);
        // The lookup is asynchronous: apply only to the same item, row and account.
        const stillValid = () => session() && hashItemId() === itemId && externalLinksContainer.isConnected
            && visibleDetailPage()?.contains(externalLinksContainer) === true;
        try {
            const item = await lookupDetailsItem(JE.helpers, itemId, false);
            if (!stillValid()) return;
            const tags = item?.Tags ?? [];
            const tagPrefix = JE.pluginConfig?.ArrTagsPrefix || 'JE Arr Tag: ';
            const relevantTags = tags.length === 0 ? [] : relevantArrTags(tags, tagPrefix,
                JE.pluginConfig?.ArrTagsLinksFilter || '', JE.pluginConfig?.ArrTagsLinksHideFilter || '');
            if (relevantTags.length === 0) {
                // Remember the verdict: don't keep checking
                withoutTags.add(itemId);
                return;
            }
            if (externalLinksContainer.querySelector('.arr-tag-link')) return;
            const server = serverId();
            for (const tag of relevantTags) {
                externalLinksContainer.appendChild(document.createTextNode(' '));
                const tagName = tag.slice(tagPrefix.length).trim();
                const slug = slugifyTagName(tagName);
                const route = tagListRoute(tag, server);
                const link = document.createElement('a');
                link.setAttribute('is', 'emby-linkbutton');
                link.className = 'button-link emby-button arr-tag-link';
                link.href = `#!/${route}`;
                link.title = `View all items with tag: ${tag}`;
                link.addEventListener('click', event => {
                    event.preventDefault();
                    navigateRoute(route);
                });
                link.dataset.itemId = itemId;
                link.dataset.id = slug;
                link.dataset.tag = tag;
                link.dataset.tagName = tagName;
                link.dataset.tagPrefix = tagPrefix;

                const icon = document.createElement('span');
                icon.className = 'arr-tag-link-icon';
                icon.setAttribute('aria-hidden', 'true');
                icon.innerHTML = JE.icon(JE.IconName.TAG);
                icon.style.marginRight = '5px';

                const label = document.createElement('span');
                label.className = 'arr-tag-link-text';
                label.dataset.id = slug;
                label.dataset.tag = tag;
                label.dataset.tagName = tagName;
                label.dataset.tagPrefix = tagPrefix;
                label.textContent = tag;

                link.append(icon, label);
                externalLinksContainer.appendChild(link);
            }
        } catch (err) {
            console.error(`${logPrefix} Error adding tag links:`, err);
        } finally {
            isAddingLinks = false;
            if (rescan) {
                rescan = false;
                scheduleCheck();
            }
        }
    }

    function checkAndAddLinks(): void {
        const externalLinksContainer = visibleDetailPage()?.querySelector('.itemExternalLinks');
        if (!externalLinksContainer) return;
        const itemId = hashItemId();
        if (itemId) void addTagLinks(itemId, externalLinksContainer);
    }

    // One trailing-edge debounce shared by the observer and the navigation hook.
    const scheduleCheck = JE.helpers.debounce(checkAndAddLinks, 100);
    JE.helpers.createObserver('arr-tag-links', () => {
        if (!JE.pluginConfig?.ArrTagsShowAsLinks) return;
        scheduleCheck();
    }, document.body, { childList: true, subtree: true });

    // Also on navigation and view show (a cached detail page re-shown by a
    // class toggle). Lifecycle-tracked for teardown.
    const lifecycle = JE.core.lifecycle.register('arr-tag-links');
    lifecycle.track(JE.core.navigation.onNavigate(scheduleCheck));
    lifecycle.track(JE.core.navigation.onViewPage(scheduleCheck));

    // Once now, in case we are already on an item detail page
    setTimeout(checkAndAddLinks, 500);
    console.log(`${logPrefix} Initialized successfully`);
};
