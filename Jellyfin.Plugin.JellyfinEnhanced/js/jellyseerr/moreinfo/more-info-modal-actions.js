// /js/jellyseerr/moreinfo/more-info-modal-actions.js
// Action-area rendering: movie request buttons, requested chips, quota chip
// and the renderActions orchestrator for the action/chip/download mounts.
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    // Shared state is seeded by more-info-modal-data.js, which plugin.js loads
    // first in this group.
    const internal = JE.internals.moreInfoModal;
    const state = internal.state;
    const logPrefix = '🪼 Jellyfin Enhanced: Jellyseerr More Info:';
    const escapeHtml = JE.escapeHtml;
    const DisplayStatus = JE.seerrStatus.DISPLAY;

/** The window a control is in (the surface its writes publish into). */
const windowOf = node => node?.closest?.('.je-more-info-modal') || null;

/**
 * Sends the window's movie request (standard or 4K) for `owner`, the press's (JE.ownerOf(event), D46S2-R7-1): a title
 * action pressing a control for its operation, else the window's own. Everything its answer changes goes through the
 * publication of `origin` (the window it was pressed in, D46S2-R8-2) taken before the await: the window's chips and
 * re-render and the cards that follow the title (its followers), the quota dialog (the publication is its owner,
 * R8-6) and an error label, only while that window is shown, `owner` is current and this is the window's newest intent;
 * `ui.idle` (the control's busy state) runs in `finally` unless the answer labelled the control (R7-6).
 * @param {Object} data Seerr details.
 * @param {boolean} is4k The 4K request.
 * @param {Object} owner The press's owner.
 * @param {HTMLElement|null} origin The window it was pressed in.
 * @param {{busy?: Function, idle?: Function, failed?: (message: string) => void, done?: Function}} [ui] The control's states.
 * @returns {Promise<void>}
 */
async function sendMovieRequest(data, is4k, owner, origin, ui = {}) {
    const submitted = JE.captureSubmitted(owner);
    if (!submitted.owner) return;
    const publication = JE.publication({ owner: submitted, surface: origin, identity: { tmdbId: data.id, mediaType: 'movie', is4k } });
    let settled = false;
    ui.busy?.();
    try {
        const response = await JE.jellyseerrAPI.requestMedia(data.id, 'movie', is4k ? { is4k: true } : {}, false, data, null, { bound: submitted.bound() });
        // The answer changes the UI only through its publication, checked as it does (D46S2-R9-5).
        settled = publication.run(() => { ui.done?.(); publication.publish({ response }); });
    } catch (error) {
        // Its owner ended before the send (nothing was sent): nothing to say.
        if (error?.name === 'AbortError') return;
        // Quota errors get a themed dialog, a publication of this window like any other answer (D46S2-R8-6): it opens
        // only while the publication is current.
        if (JE.jellyseerrUI?.isQuotaError?.(error)) {
            await JE.jellyseerrUI.showQuotaErrorDialog(error, 'movie', publication);
            return;
        }
        if (!ui.failed) return;
        settled = publication.run(() => ui.failed(error?.responseJSON?.message || JE.t('jellyseerr_btn_error')));
    } finally {
        if (!settled) ui.idle?.();
    }
}

/** The busy, idle and error states of a request button labelled `label` (an error is escaped before it is shown). */
function buttonStates(button, label) {
    const idle = `${JE.jellyseerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${label}</span>`;
    return {
        busy: () => { button.disabled = true; button.innerHTML = `<span>${JE.t('jellyseerr_btn_requesting')}</span><span class="jellyseerr-button-spinner"></span>`; },
        idle: () => { button.disabled = false; button.innerHTML = idle; },
        // Escape API error message before innerHTML to prevent reflected XSS
        failed: message => { button.disabled = false; button.innerHTML = `<span>${escapeHtml(message)}</span>${JE.jellyseerrUIIcons?.error || ''}`; button.classList.add('jellyseerr-button-error'); },
    };
}

function buildSingle4kButton(data) {
    const button = document.createElement('button');
    button.className = 'jellyseerr-request-button jellyseerr-button-request';
    button.dataset.jeEdition = '4k';
    button.innerHTML = `${JE.jellyseerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JE.t('jellyseerr_btn_request_4k') || 'Request in 4K'}</span>`;
    button.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const owner = JE.ownerOf(e);
        if (JE.jellyseerrAPI.shouldShowAdvanced()) {
            window.JellyfinEnhanced?.jellyseerrUI?.showMovieRequestModal?.(data.id, data.title || data.name, data, true, owner, windowOf(button));
            return;
        }
        await sendMovieRequest(data, true, owner, windowOf(button), buttonStates(button, JE.t('jellyseerr_btn_request_4k') || 'Request in 4K'));
    });
    return button;
}

function buildMovieActions(data, actionMount, chipMount, show4kOption) {
    const status = data.mediaInfo ? data.mediaInfo.status : 1;
    const status4k = data.mediaInfo ? data.mediaInfo.status4k : 1;
    if (!JE.seerrStatus.isRequestable(status)) {
        return null;
    }

    const container = document.createElement('div');
    container.className = 'je-more-info-actions-row';

    // Build split button (reuse card styling)
    if (show4kOption) {
        const buttonGroup = document.createElement('div');
        buttonGroup.className = 'jellyseerr-button-group je-more-info-button-group';

        const mainButton = document.createElement('button');
        mainButton.className = 'jellyseerr-request-button jellyseerr-split-main jellyseerr-button-request';
        mainButton.innerHTML = `${JE.jellyseerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JE.t('jellyseerr_btn_request')}</span>`;
        mainButton.dataset.tmdbId = data.id;
        mainButton.dataset.mediaType = 'movie';

        const arrowButton = document.createElement('button');
        arrowButton.className = 'jellyseerr-split-arrow';
        arrowButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.53 16.28a.75.75 0 01-1.06 0l-7.5-7.5a.75.75 0 011.06-1.06L12 14.69l6.97-6.97a.75.75 0 111.06 1.06l-7.5 7.5z" clip-rule="evenodd" /></svg>';
        arrowButton.title = 'Request in 4K';
        arrowButton.dataset.tmdbId = data.id;
        arrowButton.dataset.mediaType = 'movie';
        arrowButton.dataset.toggle4k = 'true';

        mainButton.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            // The press is the owner (D46S2-R7-1): the action bar's operation when the bar pressed it, else the window's.
            const owner = JE.ownerOf(e);
            if (JE.jellyseerrAPI.shouldShowAdvanced()) {
                window.JellyfinEnhanced?.jellyseerrUI?.showMovieRequestModal?.(data.id, data.title || data.name, data, false, owner, windowOf(mainButton));
                return;
            }
            await sendMovieRequest(data, false, owner, windowOf(mainButton), buttonStates(mainButton, JE.t('jellyseerr_btn_request')));
        });

    // 4K dropdown
    let open4k = null;
    const close4k = () => {
        if (open4k) {
            open4k._jeReleaseScope?.();
            open4k.remove();
            open4k = null;
            document.removeEventListener('click', handleDocClick, true);
        }
    };
    const handleDocClick = (ev) => {
        // A click outside closes it only when it is the viewer's (D46S2-R12-3): a script's click elsewhere does not.
        if (!open4k || !JE.isViewerInput(ev)) return;
        if (!open4k.contains(ev.target) && !arrowButton.contains(ev.target)) {
            close4k();
        }
    };

        arrowButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (open4k) {
            close4k();
            return;
        }
        const menu = document.createElement('div');
        menu.className = 'je-4k-popup';
        const option = document.createElement('button');
        option.className = 'je-4k-popup-item';

        const moviePopupDs4k = JE.seerrStatus.resolveDisplayStatus(status4k, false);
        if (moviePopupDs4k === DisplayStatus.AVAILABLE) {
            option.textContent = 'Request in 4K';
            option.disabled = true;
            option.classList.add('je-4k-available');
        } else if (moviePopupDs4k === DisplayStatus.PENDING || moviePopupDs4k === DisplayStatus.REQUESTED || moviePopupDs4k === DisplayStatus.PROCESSING) {
            option.textContent = 'Request in 4K';
            option.disabled = true;
            option.classList.add(moviePopupDs4k === DisplayStatus.PROCESSING ? 'je-4k-processing' : 'je-4k-pending');
        } else if (moviePopupDs4k === DisplayStatus.BLOCKED) {
            option.textContent = 'Request in 4K';
            option.disabled = true;
            option.classList.add('je-4k-blocklisted');
        } else {
            option.textContent = 'Request in 4K';
            option.classList.add('je-4k-request');
            option.addEventListener('click', async (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const owner = JE.ownerOf(ev);
                const origin = windowOf(arrowButton);
                if (JE.jellyseerrAPI.shouldShowAdvanced()) {
                    close4k();
                    window.JellyfinEnhanced?.jellyseerrUI?.showMovieRequestModal?.(data.id, data.title || data.name, data, true, owner, origin);
                    return;
                }
                // Restore option to idle on a refusal (a quota error gets its themed dialog first).
                await sendMovieRequest(data, true, owner, origin, {
                    busy: () => { option.disabled = true; option.textContent = JE.t('jellyseerr_btn_requesting'); },
                    idle: () => { option.disabled = false; option.textContent = 'Request in 4K'; },
                    failed: message => { option.disabled = false; option.textContent = message; },
                    done: close4k,
                });
            });
        }

        menu.appendChild(option);
        // Portaled to the body, outside the window: a popup of the press's owner (a title action's operation, else the
        // window's), so it closes, and its option sends nothing, once that owner ends (D46S2-R5-3, R7-1); placed in the
        // viewport, following the page, and closed by Escape / Back with focus back on the arrow (D46S2 audit S6).
        menu._jeReleaseScope = JE.openPopup(menu, { anchor: arrowButton, owner: JE.ownerOf(e), opener: arrowButton, keyboard: e.detail === 0,
            gap: 6, matchWidth: false, close: () => { if (open4k === menu) close4k(); } });
        if (!menu._jeReleaseScope) return;
        requestAnimationFrame(() => menu.classList.add('show'));
        open4k = menu;
        document.addEventListener('click', handleDocClick, true);
    });

        buttonGroup.appendChild(mainButton);
        buttonGroup.appendChild(arrowButton);
        container.appendChild(buttonGroup);
    } else {
        const requestButton = document.createElement('button');
        requestButton.className = 'jellyseerr-request-button jellyseerr-button-request';
        requestButton.innerHTML = `${JE.jellyseerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JE.t('jellyseerr_btn_request')}</span>`;
        requestButton.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const owner = JE.ownerOf(e);
            if (JE.jellyseerrAPI.shouldShowAdvanced()) {
                window.JellyfinEnhanced?.jellyseerrUI?.showMovieRequestModal?.(data.id, data.title || data.name, data, false, owner, windowOf(requestButton));
                return;
            }
            await sendMovieRequest(data, false, owner, windowOf(requestButton), buttonStates(requestButton, JE.t('jellyseerr_btn_request')));
        });
        container.appendChild(requestButton);
    }
    return container;
}

/**
 * The window's 4K movie request, as its 4K option makes it (the advanced form when that is on), for the action bar's
 * More sheet (D46S2-R6, Q-D46S2FIX5-1): `owner` is the sheet entry's submitted operation (D46S2-R7-1), so the request,
 * and the form it opens, are that operation's even in a window opened natively; `origin` is the window (D46S2-R8-2).
 * @param {Object} data Seerr details.
 * @param {Object} owner The submitted operation.
 * @param {HTMLElement} origin The window.
 * @returns {Promise<void>}
 */
async function requestMovie4k(data, owner, origin) {
    if (JE.jellyseerrAPI.shouldShowAdvanced()) {
        JE.jellyseerrUI?.showMovieRequestModal?.(data.id, data.title || data.name, data, true, owner, origin);
        return;
    }
    await sendMovieRequest(data, true, owner, origin, { failed: message => JE.toast?.(escapeHtml(message), 4000) });
}

/**
 * Records a movie request's answer in the window's details (only the edition it was for): Seerr's status from the
 * answer, else requested. The window's completion listener calls it for its own publications (D46S2-R8-2).
 * @param {Object} data Seerr details.
 * @param {boolean} is4k The 4K edition.
 * @param {Object|null} response Seerr's answer.
 * @returns {void}
 */
function applyRequested(data, is4k, response) {
    const mediaInfo = data.mediaInfo = data.mediaInfo || {};
    if (is4k) mediaInfo.status4k = response?.media?.status4k || 3;
    else mediaInfo.status = response?.media?.status || 3;
}

// Token guards against stale chip insertion when the user navigates between items.
let _quotaRenderToken = 0;
// Guards the asynchronous TV-action tail against a newer render that already
// cleared and repopulated the mounts.
let _renderActionsToken = 0;

/**
 * Seerr's request quota as a chip in the window's actions. Not for public details (Jellyfin Enhanced handles requests,
 * or the viewer has no Seerr account): there is no Seerr quota to ask for then.
 * @param {HTMLElement|null} actionMount The window's action mount.
 * @param {string} mediaType 'movie' or 'tv'.
 * @param {Object} [data] The window's details.
 * @returns {Promise<void>}
 */
async function maybeRenderMoreInfoQuotaChip(actionMount, mediaType, data) {
    if (!actionMount || data?.jePublicDetails === true) return;
    const myToken = ++_quotaRenderToken;
    actionMount.dataset.quotaRenderToken = String(myToken);

    try {
        const quota = await JE.jellyseerrAPI?.fetchUserQuota?.();
        if (!actionMount.isConnected) return;
        if (actionMount.dataset.quotaRenderToken !== String(myToken)) return;

        const chip = JE.jellyseerrUI?.buildQuotaChip?.(quota, mediaType === 'tv' ? 'tv' : 'movie');
        if (chip instanceof Element) {
            chip.classList.add('je-more-info-quota-chip');
            actionMount.insertBefore(chip, actionMount.firstChild);
        }
    } catch (err) {
        console.warn(`${logPrefix} quota chip render failed:`, err);
    }
}

function resolveRequesterAvatarSrc(avatar) {
    if (!avatar) return null;
    if (avatar.startsWith('/')) {
        // Seerr off (the server's rule, isolation included): no Seerr account image through the server.
        if (JE.pluginConfig?.JellyseerrEnabled === false || JE.pluginConfig?.SeerrAvailable === false) return null;
        return ApiClient.getUrl('/JellyfinEnhanced/proxy/avatar', { path: avatar });
    }
    return avatar;
}

function renderRequestedBy(mount, mediaInfo) {
    if (!mount) return;
    const requests = Array.isArray(mediaInfo?.requests) ? mediaInfo.requests : [];
    if (requests.length === 0) return;

    const seen = new Set();
    const entries = [];
    requests.forEach(req => {
        const requestedBy = req?.requestedBy;
        const name = requestedBy?.displayName || requestedBy?.username;
        if (!name) return;
        const label = req.is4k ? `${name} (4K)` : name;
        if (seen.has(label)) return;
        seen.add(label);
        entries.push({ label, avatarSrc: resolveRequesterAvatarSrc(requestedBy?.avatar) });
    });
    if (entries.length === 0) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'je-requested-by-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'je-requested-by-label';
    labelEl.textContent = JE.t('jellyseerr_modal_requested_by') || 'Requested by';
    wrapper.appendChild(labelEl);

    entries.forEach(entry => {
        const item = document.createElement('span');
        item.className = 'je-requested-by-item';

        if (entry.avatarSrc) {
            const img = document.createElement('img');
            img.className = 'je-request-avatar';
            img.setAttribute('data-avatar-src', entry.avatarSrc);
            img.alt = '';
            img.loading = 'lazy';
            img.style.display = 'none';
            img.addEventListener('error', () => { img.style.display = 'none'; });
            item.appendChild(img);
        }

        const nameEl = document.createElement('span');
        nameEl.className = 'je-requested-by-name';
        nameEl.textContent = entry.label;
        item.appendChild(nameEl);
        wrapper.appendChild(item);
    });

    mount.appendChild(wrapper);
    JE.helpers?.hydrateAvatarImages?.(mount);
}

/**
 * Public details (the viewer has no Seerr account Jellyfin Enhanced could read through): one plain line says
 * that what only a Seerr account has (who asked, Seerr's downloads and quota) isn't shown.
 * @param {HTMLElement|null} mount The requested-by mount.
 * @returns {void}
 */
function renderPublicNote(mount) {
    if (!mount) return;
    const note = document.createElement('div');
    note.className = 'je-requested-by-row je-more-info-public-note';
    note.textContent = JE.t('jellyseerr_modal_public_details');
    mount.appendChild(note);
}

/**
 * True when the 4K edition of the window's title can still be requested (Seerr's 4K status).
 * @param {Object} data Seerr details.
 * @returns {boolean} Requestable in 4K.
 */
function fourKRequestable(data) {
    const info = data?.mediaInfo || {};
    return JE.seerrStatus.isRequestable(JE.seerrStatus.effectiveMediaStatus(info.status4k ?? 1, info.jellyfinMediaId4k || null));
}

/**
 * Jellyfin Enhanced mode (Requests & downloads): the window's Request controls say up front when the title can't
 * be asked for right now (e.g. "Paused: storage full": the drive it would land on is nearly full), as the title
 * page and the request sheet do, instead of only a refusal toast once Request is pressed. Each standard or 4K
 * control the title check refuses (JE.arrAsk.check, per edition) gives way to the paused line (where and how much
 * is free for administrators); a standard split button keeps "Request in 4K" when that edition can still be asked
 * for. Seerr mode, or the request feature off: nothing changes.
 * @param {HTMLElement|null} actionMount The window's action mount.
 * @param {Object} data Seerr details.
 * @param {string} mediaType 'movie' or 'tv'.
 * @param {number} token The render the controls belong to (a newer render wins).
 * @returns {Promise<void>}
 */
const pauseContexts = new WeakMap();
const pauseVerdicts = new WeakMap();

/** Ordinary host passes share a bounded attempt owned by the original render and session. */
function reconcilePaused(actionMount) {
    const context = pauseContexts.get(actionMount);
    if (!context || !context.current()) return Promise.resolve();
    if (context.pending) return context.pending;
    if (context.attempts >= 3 || Date.now() < context.nextAttempt || ![...actionMount.children].some(n =>
        n.matches('.je-more-info-actions-row, .jellyseerr-request-button') && pauseVerdicts.get(n) !== context)) return Promise.resolve();
    context.attempts++;
    context.pending = checkPaused(actionMount, context).finally(() => {
        context.pending = null;
        context.nextAttempt = Date.now() + Math.min(30000, 1000 * (2 ** (context.attempts - 1)));
    });
    return context.pending;
}

function showPaused(actionMount, data, mediaType, token) {
    if (!actionMount) return Promise.resolve();
    let context = pauseContexts.get(actionMount);
    if (!context || context.token !== token || context.data !== data || context.mediaType !== mediaType) {
        const action = JE.createSessionAction();
        const modal = state.currentModal;
        context = { data, mediaType, token, attempts: 0, nextAttempt: 0, pending: null,
            current: () => action.current() && token === _renderActionsToken && actionMount.isConnected && state.currentModal === modal && !modal?._isClosing };
        pauseContexts.set(actionMount, context);
    }
    return reconcilePaused(actionMount);
}

async function checkPaused(actionMount, context) {
    const { data, mediaType, current } = context;
    const ask = JE.arrAsk;
    if (!current() || JE.internals?.arrAskSeerr?.jeMode?.() !== true || typeof ask?.check !== 'function'
        || typeof ask.blockWords !== 'function' || typeof ask.pausedNote !== 'function') return;
    const id = Number.parseInt(String(data?.id ?? ''), 10);
    if (!Number.isInteger(id) || id <= 0) return;
    const controls = [...actionMount.children].filter(n => n.matches('.je-more-info-actions-row, .jellyseerr-request-button') && pauseVerdicts.get(n) !== context);
    if (!controls.length) return;
    // DOM clones do not inherit this session's private verdict ownership.
    controls.forEach(control => { delete control.dataset.jePauseChecked; });
    const movie = mediaType === 'movie';
    const caps = await ask.me();
    if (!current() || !caps) return;
    const finish = control => { pauseVerdicts.set(control, context); control.dataset.jePauseChecked = '1'; };
    if (!ask.canAsk(caps, movie ? 'movie' : 'series')) {
        controls.forEach(finish); // A definitive capability denial is a final decision too.
        return;
    }
    const key = `${movie ? 'movie' : 'tv'}:tmdb:${id}`;
    let added = false;
    for (const control of controls) {
        const variant = control.dataset.jeEdition === '4k' ? '4k' : 'standard';
        const check = await ask.check(key, variant);
        if (!current()) return;
        if (!control.isConnected || !check) continue;
        finish(control);
        if (check.canRequest || !check.blocked) continue;
        const words = ask.blockWords(check.blocked, caps);
        if (!words) continue;
        JE.internals?.arrAskStyles?.ensure?.();
        const note = ask.pausedNote(words);
        note.classList.add('je-more-info-paused');
        note.dataset.jeEdition = variant;
        const replacement = [note];
        if (variant === 'standard' && control.querySelector('.jellyseerr-split-arrow') && fourKRequestable(data)) {
            const fourK = movie ? buildSingle4kButton(data) : internal.buildSingleTv4kButton?.(data);
            if (fourK) { replacement.push(fourK); added = true; }
        }
        control.replaceWith(...replacement);
    }
    // A new 4K control belongs to this same attempt, never a fresh session capture.
    if (added && current()) await checkPaused(actionMount, context);
}

/**
 * Renders the window's request actions, status chips and downloads, then (Jellyfin Enhanced mode) marks the
 * controls that can't be used right now ({@link showPaused}).
 * @param {Object} data Seerr details.
 * @param {string} mediaType 'movie' or 'tv'.
 * @returns {void}
 */
function renderActions(data, mediaType) {
    drawActions(data, mediaType);
    const actionMount = state.currentModal?.querySelector('[data-mount="je-actions"]');
    if (actionMount) showPaused(actionMount, data, mediaType, _renderActionsToken).catch(() => { /* the controls stay as drawn */ });
}

/**
 * Draws the window's request actions, status chips and downloads ({@link renderActions}).
 * @param {Object} data Seerr details.
 * @param {string} mediaType 'movie' or 'tv'.
 * @returns {void}
 */
function drawActions(data, mediaType) {
    if (!state.currentModal) return;

    const actionMount = state.currentModal.querySelector('[data-mount="je-actions"]');
    const chipMount = state.currentModal.querySelector('[data-mount="je-status-chip"]');
    const downloadsMount = state.currentModal.querySelector('[data-mount="je-downloads"]');
    const secondaryMount = state.currentModal.querySelector('[data-mount="je-secondary-actions"]');
    const requestedByMount = state.currentModal.querySelector('[data-mount="je-requested-by"]');
    if (actionMount) actionMount.innerHTML = '';
    if (chipMount) chipMount.innerHTML = '';
    if (downloadsMount) downloadsMount.innerHTML = '';
    if (secondaryMount) secondaryMount.innerHTML = '';
    if (requestedByMount) requestedByMount.innerHTML = '';

    const myToken = ++_renderActionsToken;
    // The window's 4K request for the action bar's More sheet: set below while Seerr 4K is on and 4K can be requested.
    const modal = state.currentModal;
    modal.jeRequest4k = null;
    renderRequestedBy(requestedByMount, data.mediaInfo);
    // The note explains a missing Seerr account; with Seerr off there is no account to miss, so it says nothing.
    if (data.jePublicDetails === true && JE.pluginConfig?.SeerrAvailable !== false) renderPublicNote(requestedByMount);
    JE.internals.spoilerGuard?.appendSeerrToggle?.(secondaryMount, data, mediaType);
    const hide = JE.hiddenContent?.buildTitleControl?.({ ...data, mediaType, tmdbId: data.id, name: data.title || data.name }, { detail: true });
    if (hide) secondaryMount?.appendChild(hide);

    if (mediaType === 'movie') {
        const mediaInfo = data.mediaInfo || {};
        const status = mediaInfo.status ?? 1;
        const status4k = mediaInfo.status4k ?? 1;
        const downloads = mediaInfo.downloadStatus || [];
        const downloads4k = mediaInfo.downloadStatus4k || [];
        const jellyfinMediaId = mediaInfo.jellyfinMediaId || null;
        const jellyfinMediaId4k = mediaInfo.jellyfinMediaId4k || null;
        const show4k = !!JE.pluginConfig.JellyseerrEnable4KRequests;

        // Show both chips if both statuses exist
        const hasNormalStatus = JE.seerrStatus.hasStatus(status);
        const has4kStatus = JE.seerrStatus.hasStatus(status4k);

        if (chipMount) {
            if (hasNormalStatus && has4kStatus) {
                // Show both chips
                const chipNormal = internal.buildStatusChip(status, status4k, true, downloads, downloads4k, jellyfinMediaId, jellyfinMediaId4k, false);
                const chip4k = internal.buildStatusChip(status, status4k, true, downloads, downloads4k, jellyfinMediaId, jellyfinMediaId4k, true);
                if (chipNormal) chipMount.appendChild(chipNormal);
                if (chip4k) {
                    chip4k.style.marginLeft = '0.5em';
                    chipMount.appendChild(chip4k);
                }
            } else if (hasNormalStatus) {
                // Show only normal chip
                const chip = internal.buildStatusChip(status, status4k, true, downloads, downloads4k, jellyfinMediaId, jellyfinMediaId4k, false);
                if (chip) chipMount.appendChild(chip);
            } else if (has4kStatus) {
                // Show only 4K chip
                const chip = internal.buildStatusChip(status, status4k, true, downloads, downloads4k, jellyfinMediaId, jellyfinMediaId4k, true);
                if (chip) chipMount.appendChild(chip);
            }
        }

        const bars = internal.buildDownloadBars(downloads, downloads4k);
        if (bars && downloadsMount) downloadsMount.appendChild(bars);

        const effectiveMovieStatus = JE.seerrStatus.effectiveMediaStatus(status, jellyfinMediaId);
        const effectiveMovieStatus4k = JE.seerrStatus.effectiveMediaStatus(status4k, jellyfinMediaId4k);

        const canRequestNormal = JE.seerrStatus.isRequestable(effectiveMovieStatus);
        const canRequest4k = JE.seerrStatus.isRequestable(effectiveMovieStatus4k);
        if (show4k && canRequest4k) modal.jeRequest4k = owner => requestMovie4k(data, owner, modal);

        if (!canRequestNormal) {
            if (show4k && canRequest4k && actionMount) {
                const followUp = buildSingle4kButton(data);
                if (followUp) actionMount.appendChild(followUp);
                maybeRenderMoreInfoQuotaChip(actionMount, 'movie', data);
            }
            return;
        }

        const actions = buildMovieActions(data, actionMount, chipMount, show4k);
        if (actions && actionMount) actionMount.appendChild(actions);
        maybeRenderMoreInfoQuotaChip(actionMount, 'movie', data);
    } else {
        const mediaInfo = data.mediaInfo || {};
        const status = mediaInfo.status ?? 1;
        const status4k = mediaInfo.status4k ?? 1;
        const downloads = mediaInfo.downloadStatus || [];
        const downloads4k = mediaInfo.downloadStatus4k || [];
        const jellyfinMediaId = mediaInfo.jellyfinMediaId || null;
        const jellyfinMediaId4k = mediaInfo.jellyfinMediaId4k || null;
        const show4kTv = !!JE.pluginConfig.JellyseerrEnable4KTvRequests;

        // Show both chips if both statuses exist
        const hasNormalStatus = JE.seerrStatus.hasStatus(status);
        const has4kStatus = JE.seerrStatus.hasStatus(status4k);

        if (chipMount) {
            if (hasNormalStatus && has4kStatus) {
                // Show both chips
                const chipNormal = internal.buildStatusChip(status, status4k, false, downloads, downloads4k, jellyfinMediaId, jellyfinMediaId4k, false);
                const chip4k = internal.buildStatusChip(status, status4k, false, downloads, downloads4k, jellyfinMediaId, jellyfinMediaId4k, true);
                if (chipNormal) chipMount.appendChild(chipNormal);
                if (chip4k) {
                    chip4k.style.marginLeft = '0.5em';
                    chipMount.appendChild(chip4k);
                }
            } else if (hasNormalStatus) {
                // Show only normal chip
                const chip = internal.buildStatusChip(status, status4k, false, downloads, downloads4k, jellyfinMediaId, jellyfinMediaId4k, false);
                if (chip) chipMount.appendChild(chip);
            } else if (has4kStatus) {
                // Show only 4K chip
                const chip = internal.buildStatusChip(status, status4k, false, downloads, downloads4k, jellyfinMediaId, jellyfinMediaId4k, true);
                if (chip) chipMount.appendChild(chip);
            }
        }

        const bars = internal.buildDownloadBars(downloads, downloads4k);
        if (bars && downloadsMount) downloadsMount.appendChild(bars);

        const effectiveStatus = JE.seerrStatus.effectiveMediaStatus(status, jellyfinMediaId);
        const effectiveStatus4k = JE.seerrStatus.effectiveMediaStatus(status4k, jellyfinMediaId4k);

        const canRequestNormal = JE.seerrStatus.isRequestable(effectiveStatus);
        const canRequest4k = JE.seerrStatus.isRequestable(effectiveStatus4k);
        if (show4kTv && canRequest4k) modal.jeRequest4k = owner => JE.jellyseerrUI?.showSeasonSelectionModal?.(data.id, 'tv', data.title || data.name, data, true, owner, modal);
        if (canRequestNormal) {
            const actions = internal.buildTvActions(data, show4kTv);
            if (actions && actionMount) actionMount.appendChild(actions);
            maybeRenderMoreInfoQuotaChip(actionMount, 'tv', data);
            return;
        }

        const hasStatus = hasNormalStatus || has4kStatus;
        const hasDeletedStatus = effectiveStatus === 7 || effectiveStatus4k === 7;

        // Check if there are unrequested seasons
        if (hasStatus) {
            if (hasDeletedStatus && actionMount) {
                const requestMoreButton = internal.buildTvRequestMoreButton(data, show4kTv, canRequest4k);
                if (requestMoreButton) actionMount.appendChild(requestMoreButton);
                maybeRenderMoreInfoQuotaChip(actionMount, 'tv', data);
                return;
            }
            internal.checkForUnrequestedSeasons(data).then(hasUnrequestedSeasons => {
                // Only the newest render, into a window still shown (a closed one's owner may have ended).
                if (myToken !== _renderActionsToken || !actionMount?.isConnected) return;
                if (hasUnrequestedSeasons && actionMount) {
                    const requestMoreButton = internal.buildTvRequestMoreButton(data, show4kTv, canRequest4k);
                    if (requestMoreButton) actionMount.appendChild(requestMoreButton);
                    maybeRenderMoreInfoQuotaChip(actionMount, 'tv', data);
                } else if (show4kTv && canRequest4k && actionMount) {
                    const followUp4k = internal.buildSingleTv4kButton(data);
                    if (followUp4k) actionMount.appendChild(followUp4k);
                    maybeRenderMoreInfoQuotaChip(actionMount, 'tv', data);
                }
                if (actionMount) showPaused(actionMount, data, mediaType, myToken).catch(() => { /* the controls stay as drawn */ });
            });
            return;
        }

        const actions = internal.buildTvActions(data);
        if (actions && actionMount) actionMount.appendChild(actions);
        maybeRenderMoreInfoQuotaChip(actionMount, 'tv', data);
    }
}
    internal.buildSingle4kButton = buildSingle4kButton;
    internal.buildMovieActions = buildMovieActions;
    internal.applyRequested = applyRequested;
    internal.maybeRenderMoreInfoQuotaChip = maybeRenderMoreInfoQuotaChip;
    internal.renderActions = renderActions;
    internal.reconcilePaused = reconcilePaused;

})(window.JellyfinEnhanced);
