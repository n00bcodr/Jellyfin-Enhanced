/**
 * Random-item header button: fetches a random movie/series and navigates to it.
 *
 * Two per-user settings narrow where the pick comes from:
 *   - randomScopeCurrentContainer: on a Playlist/BoxSet details page, pick
 *     from that container's items.
 *   - randomSourceId: a pinned playlist/collection to pick from on every page.
 * Either falls back to the whole library (with a toast) when it yields nothing.
 */
import { api, bridge, currentUserId, embyPage, dashboard, serverId } from './host';
import type { RandomBridge } from './host';
import { hashItemId, lookupDetailsItem, sessionLease } from './page';
import { decodeItems, errorMessage } from './wire';
import type { DetailsItem } from './wire';
import { DICE_FACES, candidatesPath, detailsRoute, filterUnwatched, isContainer, randomDiceFace } from './random-domain';

const JE = bridge<RandomBridge>('Random button');
const random = () => Math.random();

// Why the current press fell back to the whole library, if it did. Shown in
// place of the plain "loaded" toast so the two do not stack (toasts share one
// fixed position).
let fallbackNotice: string | null = null;

/** null when the item cannot be read (deleted, no access). */
async function fetchItem(itemId: string): Promise<DetailsItem | null> {
    try {
        return await lookupDetailsItem(JE.helpers, itemId, true);
    } catch {
        return null;
    }
}

/**
 * The playlist or collection to draw from: the one open on screen when "scope
 * to current playlist/collection" is on, else the pinned source, else null.
 */
async function resolveSourceContainer(): Promise<DetailsItem | null> {
    const settings = JE.currentSettings;
    if (settings.randomScopeCurrentContainer && /details/.test(window.location.hash)) {
        const itemId = hashItemId();
        const item = itemId ? await fetchItem(itemId) : null;
        if (isContainer(item)) return item;
    }
    const pinnedId = settings.randomSourceId;
    if (pinnedId) {
        // Validate by type rather than by "did the request succeed": a deleted
        // id 404s, but the all-zero id answers with the user's root folder.
        const item = await fetchItem(pinnedId);
        if (isContainer(item)) return item;
        fallbackNotice = JE.t('toast_random_source_missing');
    }
    return null;
}

/** Up to 100 candidates in random order (a container's children, or the library). */
async function fetchCandidates(userId: string, parentId: string | null): Promise<DetailsItem[]> {
    const client = api();
    const url = client.getUrl(candidatesPath(userId, JE.currentSettings, parentId));
    return decodeItems(await client.ajax({ type: 'GET', url, dataType: 'json' }));
}

async function getRandomItem(): Promise<DetailsItem | null> {
    const userId = currentUserId();
    if (!userId) {
        console.error('🪼 Jellyfin Enhanced: User not logged in.');
        return null;
    }
    try {
        const container = await resolveSourceContainer();
        let items = container ? filterUnwatched(JE.currentSettings, await fetchCandidates(userId, container.Id ?? null)) : [];
        if (container && items.length === 0) {
            fallbackNotice = JE.t('toast_random_source_empty', { name: JE.escapeHtml(container.Name ?? '') });
        }
        if (items.length === 0) {
            const libraryItems = await fetchCandidates(userId, null);
            if (libraryItems.length === 0) throw new Error('No items found in selected libraries.');
            items = filterUnwatched(JE.currentSettings, libraryItems);
            if (items.length === 0) throw new Error('No unwatched items found in selected libraries.');
        }
        return items[Math.floor(random() * items.length)] ?? null;
    } catch (error) {
        console.error('🪼 Jellyfin Enhanced: Error fetching random item:', error);
        // Toasts render HTML; an error message is text.
        JE.toast(`${JE.icon(JE.IconName.ERROR)} ${JE.escapeHtml(errorMessage(error) || 'Unknown error')}`, 2000);
        return null;
    }
}

function navigateToItem(item: DetailsItem): void {
    if (item.Id) {
        const page = embyPage();
        if (page && typeof page.show === 'function') {
            page.show(detailsRoute(item.Id, serverId()));
        } else {
            const host = dashboard();
            if (host && typeof host.navigate === 'function') {
                host.navigate(`details.html?id=${item.Id}`);
            } else {
                window.location.hash = `#!${detailsRoute(item.Id, serverId())}`;
            }
        }
        JE.toast(fallbackNotice || JE.t('toast_random_item_loaded'), fallbackNotice ? 3000 : 2000);
        fallbackNotice = null;
    } else {
        console.error('🪼 Jellyfin Enhanced: Invalid item object or ID:', item);
        JE.toast(JE.t('toast_generic_error'), 2000);
    }
}

/** Creates and injects the "Random" button into the page header if enabled. */
JE.addRandomButton = () => {
    if (!JE.currentSettings.randomButtonEnabled) {
        document.getElementById('randomItemButtonContainer')?.remove();
        return;
    }
    if (document.getElementById('randomItemButton')) return;

    // Getting the tray also reconnects its existing buttons after a native
    // header remount; check the ID only after that reconciliation.
    const headerRight = JE.helpers.getHeaderButtonTray();
    if (!headerRight || document.getElementById('randomItemButton')) return;

    const buttonContainer = document.createElement('div');
    buttonContainer.id = 'randomItemButtonContainer';

    const randomButton = document.createElement('button');
    randomButton.id = 'randomItemButton';
    randomButton.setAttribute('is', 'paper-icon-button-light');
    randomButton.className = 'headerButton headerButtonRight paper-icon-button-light';
    randomButton.title = JE.t('random_button_tooltip');
    const headerLabel = JE.t('header_random_item');
    randomButton.dataset.headerLabel = headerLabel === 'header_random_item' ? 'Random item' : headerLabel;
    const spin = document.createElement('span');
    spin.className = 'je-dice-spin';
    const diceFace = document.createElement('span');
    diceFace.className = 'je-dice-face';
    spin.appendChild(diceFace);
    randomButton.appendChild(spin);
    let currentFace = randomDiceFace(random);
    diceFace.innerHTML = DICE_FACES[currentFace] ?? '';

    randomButton.addEventListener('click', async () => {
        randomButton.disabled = true;
        randomButton.classList.add('loading');
        // Cleared per press, not per draw: a reason left by a draw that threw
        // must not ride on a later navigation.
        fallbackNotice = null;
        const current = sessionLease(JE.session);

        const rollDice = () => {
            currentFace = randomDiceFace(random, currentFace);
            diceFace.innerHTML = DICE_FACES[currentFace] ?? '';
        };
        const rollInterval = setInterval(rollDice, 120);

        try {
            const item = await getRandomItem();
            // A pick made for the previous account is not opened for the next.
            if (item && current()) navigateToItem(item);
        } finally {
            clearInterval(rollInterval);
            setTimeout(() => {
                if (document.getElementById(randomButton.id)) {
                    randomButton.disabled = false;
                    randomButton.classList.remove('loading');
                    rollDice();
                }
            }, 500);
        }
    });

    buttonContainer.appendChild(randomButton);
    headerRight.prepend(buttonContainer);
};
