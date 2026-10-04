// /js/jellyseerr/ui/ui-cards.js
// Seerr search-result card construction.
(function(JE) {
    'use strict';

    const ui = JE.jellyseerrUI = JE.jellyseerrUI || {};
    JE.internals = JE.internals || {};
    // Shared state is seeded by ui-icons.js, which plugin.js loads first
    // in this group.
    const internal = JE.internals.jellyseerrUi;
    const MediaStatus = JE.seerrStatus.MEDIA;
    const icons = internal.icons; // requires ui-icons.js to be loaded first
    const escapeHtml = JE.escapeHtml;
    const addDelegatedTouchTapListener = JE.core.ui.addDelegatedTouchTapListener;

    // ---- Lazy poster loading -------------------------------------------------
    // The infinite-scroll engine keeps roughly three viewports of cards rendered
    // ahead of the viewer. If every card set its poster as an inline
    // background-image at creation time, all of those off-screen cards would
    // fire requests at image.tmdb.org immediately. Instead the poster URL is
    // parked on the element (data-je-poster) and applied only when the card
    // comes within ~800px of the viewport, via one shared IntersectionObserver.
    // IntersectionObserver is geometry-based, so it also works inside
    // emby-scroller rows (which scroll via CSS transforms on TV clients) and
    // for elements observed while still inside a DocumentFragment: they simply
    // report as not intersecting until they are attached to the document.
    const POSTER_DATA_KEY = 'jePoster'; // dataset key for the data-je-poster attribute
    let posterObserver = null;
    // Every observed poster container; IntersectionObserver holds strong references
    // to its targets, so cards removed before they ever scrolled into view must be
    // unobserved explicitly or they (and their handlers) are retained forever.
    const observedPosters = new Set();

    /**
     * Sets the poster image on a card's image element and stops observing it.
     * @param {HTMLElement|null} el - Element carrying the pending poster URL in its dataset
     */
    function applyPoster(el) {
        if (!el) return;
        const url = el.dataset[POSTER_DATA_KEY];
        if (posterObserver) {
            try { posterObserver.unobserve(el); } catch (_) { /* ignore */ }
        }
        observedPosters.delete(el);
        if (!url) return;
        delete el.dataset[POSTER_DATA_KEY];
        // posterUrl is validated/derived in createJellyseerrCard, so the only
        // characters that could upset the url() literal are quotes; escape anyway.
        el.style.backgroundImage = `url("${url.replace(/["\\]/g, '\\$&')}")`;
        // CSS backgrounds have no load event, so an Image probe for the same URL
        // (sharing the background's in-flight/cached resource, not a second
        // network fetch) tells this card's deferred provider-icon lookup when
        // the main image has loaded or failed.
        const probe = new Image();
        probe.onload = probe.onerror = () => settlePoster(el);
        probe.src = url;
    }

    // Poster element -> { promise, resolve }; settles once that card's poster
    // has loaded or failed. WeakMap so detached cards are not retained.
    const posterReadiness = new WeakMap();

    /**
     * Returns the readiness record for a card's poster, creating it on demand.
     * @param {HTMLElement} el - The card's image element
     * @returns {{promise: Promise<void>, resolve: Function}}
     */
    function getPosterReadiness(el) {
        let record = posterReadiness.get(el);
        if (!record) {
            let resolve;
            const promise = new Promise((r) => { resolve = r; });
            record = { promise, resolve };
            posterReadiness.set(el, record);
        }
        return record;
    }

    /**
     * Marks a card's poster as finished (loaded or failed).
     * @param {HTMLElement} el - The card's image element
     */
    function settlePoster(el) {
        getPosterReadiness(el).resolve();
    }

    /**
     * The shared IntersectionObserver that loads posters as cards approach the
     * viewport; null where IntersectionObserver is unavailable.
     * @returns {IntersectionObserver|null}
     */
    function getPosterObserver() {
        if (posterObserver) return posterObserver;
        if (typeof IntersectionObserver === 'undefined') return null;
        try {
            posterObserver = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting || entry.intersectionRatio > 0) {
                        applyPoster(entry.target);
                    }
                }
            }, { root: null, rootMargin: '800px', threshold: 0 });
        } catch (_) {
            posterObserver = null;
        }
        return posterObserver;
    }

    /**
     * Defers a card's poster until it nears the viewport (or applies it at once
     * where IntersectionObserver is unsupported).
     * @param {HTMLElement} el - The card's image element
     * @param {string} url - Poster URL
     */
    function observePoster(el, url) {
        el.dataset[POSTER_DATA_KEY] = url;
        const observer = getPosterObserver();
        if (!observer) {
            // No IntersectionObserver support: behave exactly as before.
            applyPoster(el);
            return;
        }
        try {
            observer.observe(el);
            observedPosters.add(el);
        } catch (_) {
            applyPoster(el);
        }
    }

    /**
     * Stops observing posters whose cards have been removed from the document
     * (or that sit under `root`, when given), and cancels their pending or
     * in-flight provider-icon lookups. Call after tearing down a result
     * row / discovery section so detached cards can be garbage-collected.
     * Cards still being assembled in a DocumentFragment (a batch built over
     * several tasks) are left alone unless they are under `root`.
     * @param {HTMLElement|DocumentFragment} [root]
     */
    function releasePosters(root) {
        const isReleased = (el) => (root && root.contains(el))
            || (!el.isConnected && !(el.getRootNode() instanceof DocumentFragment));
        if (posterObserver) {
            for (const el of [...observedPosters]) {
                if (isReleased(el)) {
                    try { posterObserver.unobserve(el); } catch (_) { /* ignore */ }
                    observedPosters.delete(el);
                }
            }
        }
        // Cards that never came on screen must never look up provider icons, and
        // lookups already waiting or in flight for released cards are cancelled.
        for (const [el, job] of [...iconJobs]) {
            if (isReleased(el)) cancelIconJob(el, job);
        }
    }
    ui.releasePosters = releasePosters;

    /**
     * Resolves whether a Seerr result is already in the Jellyfin library, i.e.
     * whether its card shows the "in library" state and links to Jellyfin.
     * @param {Object} item - Search result item from Seerr API.
     * @param {Object|null} [seasonAnalysis] - analyzeSeasonStatuses() of the
     *   item's seasons when the caller already has it; computed here otherwise.
     * @returns {{isAvailable: boolean, jellyfinMediaId: (string|null)}}
     */
    function getLibraryAvailability(item, seasonAnalysis) {
        const jellyfinMediaId = item?.mediaInfo?.jellyfinMediaId || item?.mediaInfo?.jellyfinMediaId4k || null;
        // For TV shows, derive the card-level availability from the season analysis so that
        // a stale Seerr jellyfinMediaId on a show where no seasons are confirmed present
        // does not produce a false "in library" green link.
        // Only AVAILABLE (all seasons present) or PARTIALLY_AVAILABLE (some present) justify the link.
        let cardEffectiveStatus;
        if (item?.mediaType === 'tv' && item.mediaInfo?.seasons?.length) {
            const sa = seasonAnalysis || internal.analyzeSeasonStatuses(item.mediaInfo.seasons);
            cardEffectiveStatus = sa ? sa.overallStatus : JE.seerrStatus.effectiveMediaStatus(item.mediaInfo?.status, jellyfinMediaId);
        } else {
            cardEffectiveStatus = JE.seerrStatus.effectiveMediaStatus(item?.mediaInfo?.status, jellyfinMediaId);
        }
        const isAvailable = Boolean(jellyfinMediaId)
            && (cardEffectiveStatus === MediaStatus.AVAILABLE || cardEffectiveStatus === MediaStatus.PARTIALLY_AVAILABLE);
        return { isAvailable, jellyfinMediaId };
    }

    /**
     * Returns true when a Seerr result is already in the Jellyfin library,
     * including TV shows with only some seasons present. Mirrors the card's
     * "in library" state, so filtering on it hides exactly those cards.
     * @param {Object} item - Search result item from Seerr API.
     * @returns {boolean}
     */
    ui.isInLibrary = (item) => getLibraryAvailability(item).isAvailable;

    // ---- Deferred streaming-provider icons ----------------------------------
    // The "Elsewhere" provider icons are decorative, yet fetching them at card
    // creation fired a watch/providers lookup (plus up to four logo images) for
    // every pre-rendered off-screen card, competing with the posters and with
    // Jellyfin's own requests. Instead each card's image element is watched by
    // a second shared IntersectionObserver with no look-ahead margin. Once the
    // card is actually on screen, its lookup waits for that card's poster to
    // load or fail (bounded by ICON_POSTER_WAIT_MS so icons are never starved)
    // and then runs at the next idle moment, once per card, provided the card
    // is still on screen by then (otherwise it waits to become visible again).
    // The image element is observed rather than the icon container, which is
    // display:none (and so never intersects) until it has icons.
    const ICON_POSTER_WAIT_MS = 3000;
    const ICON_IDLE_TIMEOUT_MS = 1000;
    let iconObserver = null;
    // Observed image element -> icon job { container, tmdbId, mediaType,
    // visible, started, cancelled, timer, cancelIdle, controller }. Strong references,
    // held until the lookup settles or releasePosters cancels the job.
    const iconJobs = new Map();

    /**
     * Runs a callback when the browser is idle (bounded), or on the next task.
     * @param {Function} fn
     * @returns {Function} Cancels the pending callback.
     */
    function runWhenIdle(fn) {
        if (typeof requestIdleCallback !== 'undefined') {
            const id = requestIdleCallback(fn, { timeout: ICON_IDLE_TIMEOUT_MS });
            return () => cancelIdleCallback(id);
        }
        const id = setTimeout(fn, 0);
        return () => clearTimeout(id);
    }

    /**
     * Cancels a card's icon job: stops observing it, clears its poster-wait
     * timer and idle callback, and aborts its lookup if in flight.
     * @param {HTMLElement} el - The observed image element
     * @param {Object} job - Its entry in iconJobs
     */
    function cancelIconJob(el, job) {
        job.cancelled = true;
        clearTimeout(job.timer);
        if (job.cancelIdle) job.cancelIdle();
        if (job.controller) job.controller.abort();
        if (iconObserver) {
            try { iconObserver.unobserve(el); } catch (_) { /* ignore */ }
        }
        iconJobs.delete(el);
    }

    /**
     * Starts a card's provider-icon lookup once its poster has settled (or the
     * wait bound elapses) and the browser is idle. If the card has left the
     * viewport by then, the job goes back to waiting for visibility; once the
     * lookup fires the card is unobserved, so it runs at most once.
     * @param {HTMLElement} el - The observed image element
     * @param {Object} job - Its entry in iconJobs
     */
    function startProviderIcons(el, job) {
        job.started = true;
        const bound = new Promise((resolve) => { job.timer = setTimeout(resolve, ICON_POSTER_WAIT_MS); });
        Promise.race([getPosterReadiness(el).promise, bound]).then(() => {
            clearTimeout(job.timer);
            if (job.cancelled) return;
            job.cancelIdle = runWhenIdle(() => {
                job.cancelIdle = null;
                if (job.cancelled) return;
                if (!job.visible || !job.container.isConnected) {
                    // Scrolled away while waiting: fire when visible again.
                    job.started = false;
                    return;
                }
                if (iconObserver) {
                    try { iconObserver.unobserve(el); } catch (_) { /* ignore */ }
                }
                job.controller = new AbortController();
                internal.fetchProviderIcons(job.container, job.tmdbId, job.mediaType, job.controller.signal)
                    .finally(() => {
                        if (iconJobs.get(el) === job) iconJobs.delete(el);
                    });
            });
        });
    }

    /**
     * The shared on-screen-only IntersectionObserver for provider icons; null
     * where IntersectionObserver is unavailable.
     * @returns {IntersectionObserver|null}
     */
    function getIconObserver() {
        if (iconObserver) return iconObserver;
        if (typeof IntersectionObserver === 'undefined') return null;
        try {
            iconObserver = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                    const job = iconJobs.get(entry.target);
                    if (!job || job.controller) continue;
                    job.visible = entry.isIntersecting || entry.intersectionRatio > 0;
                    if (job.visible && !job.started) startProviderIcons(entry.target, job);
                }
            }, { root: null, rootMargin: '0px', threshold: 0 });
        } catch (_) {
            iconObserver = null;
        }
        return iconObserver;
    }

    /**
     * Defers a card's provider-icon lookup until the card is on screen and its
     * poster has settled (or fetches at once where IntersectionObserver is
     * unsupported).
     * @param {HTMLElement} el - The card's image element (visibility target)
     * @param {HTMLElement} container - The card's .jellyseerr-elsewhere-icons element
     * @param {string|number} tmdbId
     * @param {string} mediaType
     */
    function observeProviderIcons(el, container, tmdbId, mediaType) {
        if (!el || !container) return;
        const observer = getIconObserver();
        if (!observer) {
            // No IntersectionObserver support: behave exactly as before.
            internal.fetchProviderIcons(container, tmdbId, mediaType);
            return;
        }
        iconJobs.set(el, { container, tmdbId, mediaType, visible: false, started: false,
            cancelled: false, timer: null, cancelIdle: null, controller: null });
        try {
            observer.observe(el);
        } catch (_) {
            iconJobs.delete(el);
            internal.fetchProviderIcons(container, tmdbId, mediaType);
        }
    }


    // ---- Card construction and delegated card events -------------------------
    // A discovery batch creates 80-160 cards in one go. Each card used to parse
    // its own copy of the same HTML (plus ~20 whitespace text nodes from the
    // indented template) and register ~10 listeners and closures of its own.
    // Cards are now cloned from one parsed template and filled in through their
    // fixed child positions; what the handlers need is kept per card in
    // cardStates, and one set of listeners on each element holding cards (the
    // row's / grid's itemsContainer) serves every card in it. A container gets
    // its listeners the first time anything in one of its cards is pointed at,
    // touched, focused or clicked (bindCardContainersFrom), so every caller of
    // createJellyseerrCard keeps working without registering its container.
    // The one exception is the title link's click listener, which stays on
    // the link itself (see onTitleLinkCaptureClick).

    // Card element -> its state: the item, the links derived from it, and the
    // hover overview while one is open. WeakMap, so removed cards are freed.
    const cardStates = new WeakMap();
    // Containers that already have the delegated card listeners.
    const boundContainers = new WeakSet();

    let cardTemplate = null;
    let cardTemplateIconUrl = null;

    /**
     * The parsed card markup every card is cloned from. Same elements, classes
     * and attributes as the markup each card used to parse, minus the
     * whitespace text nodes between elements (which rendered nothing). The
     * title link keeps is="emby-linkbutton", so jellyfin-web upgrades each
     * clone exactly as it upgraded the parsed cards.
     * @param {string} seerrIconUrl - URL of the small Seerr logo in the meta line
     * @returns {HTMLElement} The template card (never inserted itself)
     */
    function getCardTemplate(seerrIconUrl) {
        if (cardTemplate && cardTemplateIconUrl === seerrIconUrl) return cardTemplate;
        const template = document.createElement('template');
        template.innerHTML = '<div class="card overflowPortraitCard card-hoverable card-withuserdata jellyseerr-card">'
            + '<div class="cardBox cardBox-bottompadded">'
            + '<div class="cardScalable">'
            + '<div class="cardPadder cardPadder-overflowPortrait"></div>'
            // tabindex/cursor: keyboard and pointer activation (see the delegated handlers).
            + '<div class="cardImageContainer coveredImage cardContent jellyseerr-poster-image" style="cursor: pointer;" tabindex="0">'
            + '<div class="jellyseerr-status-badge"></div>'
            + '<div class="jellyseerr-elsewhere-icons"></div>'
            + '<div class="cardIndicators"></div>'
            + '</div>'
            // No data-action, no pointer events: Jellyfin's own card click
            // handling must leave Seerr cards alone.
            + '<div class="cardOverlayContainer" style="pointer-events: none;"></div>'
            + '</div>'
            + '<div class="cardText cardTextCentered cardText-first">'
            // is="emby-linkbutton" routes external URLs through the system browser on iOS/Android.
            + '<a is="emby-linkbutton" class="jellyseerr-more-info-link"><bdi></bdi></a>'
            + '</div>'
            + '<div class="cardText cardTextCentered cardText-secondary jellyseerr-meta">'
            + '<img class="jellyseerr-icon-on-card" alt="Seerr">'
            + '<bdi></bdi>'
            + `<div class="jellyseerr-rating">${icons.star}<span></span></div>`
            + '</div>'
            + '</div>'
            + '</div>';
        const root = /** @type {HTMLElement} */ (template.content.firstElementChild);
        root.querySelector('.jellyseerr-icon-on-card').setAttribute('src', seerrIconUrl);
        cardTemplate = root;
        cardTemplateIconUrl = seerrIconUrl;
        return cardTemplate;
    }

    // Values that are the same for every card of a batch (config flags, the
    // Seerr base URL, hidden-content settings, translated labels), computed
    // once per synchronous run of card creation instead of once per card.
    let batchContext = null;

    /**
     * Returns the per-batch constants, computing them on the first card of a
     * batch. They are dropped at the end of the current task (microtask), so
     * the next batch sees any config, settings or language change.
     * @returns {Object}
     */
    function getBatchContext() {
        if (batchContext) return batchContext;
        const config = JE.pluginConfig;
        const hiddenContent = JE.hiddenContent;
        const hiddenSettings = hiddenContent ? hiddenContent.getSettings() : null;
        const showHideButtons = !!(hiddenSettings && hiddenSettings.enabled
            && hiddenSettings.showHideButtons !== false && hiddenSettings.showButtonJellyseerr !== false);
        // Translation with an English fallback when the key is missing.
        const translated = (key, fallback) => (JE.t(key) !== key ? JE.t(key) : fallback);
        const mediaBadgeKeys = { movie: 'jellyseerr_card_badge_movie', tv: 'jellyseerr_card_badge_series', collection: 'jellyseerr_card_badge_collection' };
        const mediaBadgeLabels = {};
        let viewOnJellyseerrLabel = null;
        const ctx = {
            // Resolve Seerr URL based on mappings or fallback to base URL
            seerrBase: JE.jellyseerrAPI?.resolveJellyseerrBaseUrl() || '',
            useMoreInfoModal: !!(config && config.JellyseerrUseMoreInfoModal),
            moreInfoLoaded: !!JE.jellyseerrMoreInfo,
            // Admin opt-in: an available item's poster goes straight to Jellyfin.
            availablePostersLinkToJellyfin: !!(config && config.JellyseerrAvailablePosterLinksToJellyfin),
            showProviderIcons: !!(config && config.ShowElsewhereOnJellyseerr && config.TmdbEnabled),
            posterNotFoundUrl: JE.cdn.url('ibb', 'fdbkXQdP/jellyseerr-poster-not-found.png'),
            seerrIconUrl: JE.cdn.selfhst('svg/seerr.svg'),
            showHideButtons,
            hiddenLabel: showHideButtons ? translated('hidden_content_already_hidden', 'Hidden') : null,
            unhideLabel: showHideButtons ? translated('hidden_content_unhide', 'Unhide') : null,
            hideLabel: showHideButtons ? translated('hidden_content_hide_button', 'Hide') : null,
            /** @returns {string} Title of a title link that opens Seerr */
            viewOnJellyseerrLabel() {
                if (viewOnJellyseerrLabel === null) viewOnJellyseerrLabel = JE.t('jellyseerr_card_view_on_jellyseerr') || 'View on Jellyseerr';
                return viewOnJellyseerrLabel;
            },
            /**
             * @param {string} mediaType
             * @returns {string|undefined} The media-type badge text (undefined: no badge)
             */
            mediaBadgeLabel(mediaType) {
                const key = mediaBadgeKeys[mediaType];
                if (!key) return undefined;
                if (!(mediaType in mediaBadgeLabels)) mediaBadgeLabels[mediaType] = JE.t(key);
                return mediaBadgeLabels[mediaType];
            }
        };
        batchContext = ctx;
        queueMicrotask(() => { if (batchContext === ctx) batchContext = null; });
        return ctx;
    }

    /**
     * Creates an individual Seerr result card.
     * @param {Object} item - Search result item from Seerr API.
     * @param {boolean} isJellyseerrActive - If the server is reachable.
     * @param {boolean} jellyseerrUserFound - If the current user is linked.
     * @returns {HTMLElement} - Card element.
     */
    function createJellyseerrCard(item, isJellyseerrActive, jellyseerrUserFound) {
        const ctx = getBatchContext();
        const year = item.releaseDate?.substring(0, 4) || item.firstAirDate?.substring(0, 4) || 'N/A';
        // validate posterPath before interpolating into a CSS
        // url() context. Anything other than a leading-slash relative path
        // (TMDB always returns this shape, e.g. "/abc.jpg") is rejected so a
        // hostile poster path can't break out of the url() literal.
        const posterUrl = internal.isSafeTmdbImagePath(item.posterPath)
            ? `https://image.tmdb.org/t/p/w400${item.posterPath}`
            : ctx.posterNotFoundUrl;
        const rating = item.voteAverage ? item.voteAverage.toFixed(1) : 'N/A';
        // API-sourced title, set as text and attribute values (never parsed as HTML).
        const title = String((item.title || item.name) ?? '');
        const jellyseerrUrl = ctx.seerrBase ? `${ctx.seerrBase}/${item.mediaType}/${item.id}` : null;
        const useMoreInfoModal = ctx.useMoreInfoModal;

        // One season analysis per TV card, shared by the availability check and the status badge.
        const seasons = item.mediaType === 'tv' ? item.mediaInfo?.seasons : null;
        const seasonAnalysis = seasons ? internal.analyzeSeasonStatuses(seasons) : null;
        const { isAvailable, jellyfinMediaId } = getLibraryAvailability(item, seasonAnalysis);
        const jellyfinHref = isAvailable ? `#!/details?id=${jellyfinMediaId}` : null;
        // Admin opt-in: for an available item, the poster click goes straight to Jellyfin
        // instead of opening the More Info modal / Seerr link — same as the title link already does.
        const linksAvailableToJellyfin = isAvailable
            && item.mediaType !== 'collection'
            && ctx.availablePostersLinkToJellyfin;

        const card = /** @type {HTMLElement} */ (document.importNode(getCardTemplate(ctx.seerrIconUrl), true));
        if (isAvailable) card.classList.add('jellyseerr-card-in-library');
        // Fixed positions in the template (see getCardTemplate).
        const cardBox = /** @type {HTMLElement} */ (card.firstElementChild);
        const cardScalable = /** @type {HTMLElement} */ (cardBox.children[0]);
        const imageContainer = /** @type {HTMLElement} */ (cardScalable.children[1]);
        const titleLink = /** @type {HTMLElement} */ (cardBox.children[1].firstElementChild);
        const meta = cardBox.children[2];

        if (jellyfinHref) {
            titleLink.setAttribute('href', jellyfinHref);
        } else if (useMoreInfoModal || !jellyseerrUrl) {
            titleLink.setAttribute('href', '#');
        } else {
            titleLink.setAttribute('href', jellyseerrUrl);
            titleLink.setAttribute('target', '_blank');
            titleLink.setAttribute('rel', 'noopener noreferrer');
        }
        titleLink.setAttribute('data-tmdb-id', item.id);
        titleLink.setAttribute('data-media-type', item.mediaType);
        titleLink.setAttribute('title', (jellyfinHref || useMoreInfoModal || !jellyseerrUrl) ? title : ctx.viewOnJellyseerrLabel());
        titleLink.firstElementChild.textContent = title;
        titleLink.addEventListener('click', onTitleLinkCaptureClick, true);
        meta.children[1].textContent = year;
        meta.children[2].lastElementChild.textContent = rating;

        // Poster is loaded lazily (see observePoster above); the URL is stored via
        // dataset rather than interpolated into the markup.
        observePoster(imageContainer, posterUrl);

        // Set the status badge icon based on the item's status
        internal.setStatusBadge(card, item, seasonAnalysis);

        internal.addMediaTypeBadge(card, item, imageContainer, ctx.mediaBadgeLabel(item.mediaType));
        // If movie belongs to a collection, show a collection badge that opens the modal
        internal.addCollectionMembershipBadge(card, item, imageContainer);

        if (ctx.showProviderIcons && item.mediaType !== 'collection') {
            // Deferred until the card is on screen and its poster has settled.
            observeProviderIcons(imageContainer, imageContainer.children[1], item.id, item.mediaType);
        }

        // Add hide button for hidden content feature
        if (ctx.showHideButtons) {
            const hideBtn = document.createElement('button');
            setHideButtonState(hideBtn, JE.hiddenContent.isHiddenByTmdbId(item.id), ctx);
            cardBox.style.position = 'relative';
            cardBox.appendChild(hideBtn);
        }

        cardStates.set(card, {
            item,
            isJellyseerrActive,
            jellyseerrUserFound,
            ctx,
            useMoreInfoModal,
            jellyseerrUrl,
            jellyfinMediaId,
            jellyfinHref,
            linksAvailableToJellyfin,
            // The poster click opens the More Info modal (when it doesn't go to Jellyfin).
            posterOpensModal: useMoreInfoModal && ctx.moreInfoLoaded,
            // True when the card should navigate directly to an external Seerr URL instead of
            // opening the modal — the overview text is then a real link.
            navigatesExternally: !useMoreInfoModal && !jellyfinMediaId && !!jellyseerrUrl && item.mediaType !== 'collection',
            cardScalable,
            imageContainer,
            overview: null,
            button: null,
            outsideClick: null,
            // performance.now() of the last tap that navigated to Jellyfin; 0 once its click is seen.
            tapNavigatedAt: 0
        });

        return card;
    }

    /**
     * Renders the hide button's "hide" or "already hidden" state.
     * @param {HTMLButtonElement} hideBtn
     * @param {boolean} hidden - The item is hidden (click unhides it).
     * @param {Object} ctx - The batch context the card was created with (labels).
     */
    function setHideButtonState(hideBtn, hidden, ctx) {
        hideBtn.className = hidden ? 'je-hide-btn je-already-hidden' : 'je-hide-btn';
        hideBtn.title = hidden ? ctx.hiddenLabel : ctx.hideLabel;
        hideBtn.replaceChildren();
        const icon = document.createElement('span');
        icon.className = 'material-icons';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = hidden ? 'visibility_off' : 'visibility';
        hideBtn.appendChild(icon);
    }

    /**
     * Opens the card's item in Jellyfin.
     * @param {Object} state - The card's state
     */
    function goToJellyfinItem(state) {
        try {
            if (typeof Emby !== 'undefined' && Emby.Page?.showItem) {
                Emby.Page.showItem(state.jellyfinMediaId);
                return;
            }
        } catch (_) { /* fall through to hash */ }
        window.location.hash = state.jellyfinHref;
    }

    /**
     * Shows the card's hover overview: synopsis plus the request button,
     * which is built and configured only now.
     * @param {Object} state - The card's state
     */
    function createOverview(state) {
        const item = state.item;
        const overview = document.createElement('div');
        overview.className = 'jellyseerr-overview';
        overview.style.cursor = 'pointer';
        // When modal is disabled and item isn't in the library, wrap the description
        // text in a real <a is="emby-linkbutton"> so the user's tap opens outside the app.
        const contentHtml = state.navigatesExternally
            ? `<a is="emby-linkbutton" href="${state.jellyseerrUrl}" target="_blank" rel="noopener noreferrer" class="content jellyseerr-overview-link" style="text-decoration:none;color:inherit;">${escapeHtml((item.overview || JE.t('jellyseerr_card_no_info')).slice(0, 500))}</a>`
            : `<div class="content">${escapeHtml((item.overview || JE.t('jellyseerr_card_no_info')).slice(0, 500))}</div>`;
        overview.innerHTML = `
                    ${contentHtml}
                    <button type="button" class="jellyseerr-request-button" data-tmdb-id="${item.id}" data-media-type="${item.mediaType}"></button>
                `;

        state.overview = overview;
        state.cardScalable.appendChild(overview);
        state.button = overview.querySelector('.jellyseerr-request-button');
        internal.configureRequestButton(state.button, item, state.isJellyseerrActive, state.jellyseerrUserFound);
    }

    /**
     * Removes the card's overview and stops listening for outside clicks.
     * @param {Object} state - The card's state
     */
    function removeOverview(state) {
        const overview = state.overview;
        if (overview && overview.parentNode) {
            overview.parentNode.removeChild(overview);
            state.overview = null;
            state.button = null;
        }
        if (state.outsideClick) document.removeEventListener('click', state.outsideClick);
    }

    /**
     * After a tap or click opened the overview, closes it on the next click
     * outside the card.
     * @param {HTMLElement} card
     * @param {Object} state - The card's state
     */
    function closeOverviewOnOutsideClick(card, state) {
        if (!state.outsideClick) {
            state.outsideClick = (evt) => {
                if (!card.contains(evt.target)) {
                    removeOverview(state);
                }
            };
        }
        const handler = state.outsideClick;
        setTimeout(() => {
            document.addEventListener('click', handler);
        }, 0);
    }

    /**
     * The card an event inside a card container belongs to. Only cards whose
     * parent is that container are handled by its listeners.
     * @param {HTMLElement} container
     * @param {Event} e
     * @returns {{card: HTMLElement, state: Object, target: Element}|null}
     */
    function cardEventTarget(container, e) {
        const target = e.target;
        if (!(target instanceof Element)) return null;
        const card = /** @type {HTMLElement|null} */ (target.closest('.jellyseerr-card'));
        if (!card || card.parentElement !== container) return null;
        const state = cardStates.get(card);
        return state ? { card, state, target } : null;
    }

    /**
     * The closest element matching `selector` from `target`, if it is inside `card`.
     * @param {HTMLElement} card
     * @param {Element} target
     * @param {string} selector
     * @returns {HTMLElement|null}
     */
    function inCard(card, target, selector) {
        const el = /** @type {HTMLElement|null} */ (target.closest(selector));
        return el && card.contains(el) ? el : null;
    }

    /**
     * Capture-phase click listener on every card's title link (one shared
     * function). It stays on the link itself, not on the container, so every
     * click reaches the link exactly as before: one it stops (collection,
     * More Info modal) is stopped at the link, where engines that run a
     * target's listeners in registration order still run the link's own
     * emby-linkbutton handler (on app shells without TargetBlank that opens
     * a Seerr URL in the system browser); stopped at the container, it would
     * never reach the link at all.
     * @param {MouseEvent} e
     */
    function onTitleLinkCaptureClick(e) {
        const link = /** @type {HTMLElement} */ (e.currentTarget);
        const card = link.closest('.jellyseerr-card');
        const state = card && cardStates.get(card);
        if (state) onTitleLinkClick(e, link, state);
    }

    /**
     * Title link click (capture phase on the link, so it runs before anything
     * inside the link and before the link's own bubble-phase handlers).
     * @param {MouseEvent} e
     * @param {HTMLElement} moreInfoLink
     * @param {Object} state - The card's state
     */
    function onTitleLinkClick(e, moreInfoLink, state) {
        const item = state.item;
        // Check if this is a library item (href already set to jellyfin item)
        const href = moreInfoLink.getAttribute('href');
        const isLibraryLink = href && href.startsWith('#!/details?id=');
        const isExternalJellyseerrLink = href && /^https?:\/\//i.test(href);

        if (isLibraryLink) {
            // Allow default behavior for library links
            return;
        }

        // If collection, open collection modal
        if (item.mediaType === 'collection') {
            e.preventDefault();
            e.stopPropagation();
            ui.showCollectionRequestModal(item.id, item.name || item.title, item);
            return;
        }

        // If using modal, prevent default and open modal
        if (state.useMoreInfoModal && JE.jellyseerrMoreInfo) {
            e.preventDefault();
            e.stopPropagation();
            const tmdbId = parseInt(moreInfoLink.dataset.tmdbId);
            const mediaType = moreInfoLink.dataset.mediaType;
            if (tmdbId && mediaType) {
                JE.jellyseerrMoreInfo.open(tmdbId, mediaType);
            }
            return;
        }

        // For external Seerr links the <a> has is="emby-linkbutton" — let default run.
        const isPlainLeftClick = e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
        if (isExternalJellyseerrLink && isPlainLeftClick) {
            return;
        }
    }

    /**
     * Hide button click: hide (after confirmation) or unhide the item.
     * @param {MouseEvent} e
     * @param {HTMLButtonElement} hideBtn
     * @param {HTMLElement} card
     * @param {Object} state - The card's state
     */
    function onHideButtonClick(e, hideBtn, card, state) {
        const item = state.item;
        e.preventDefault();
        e.stopPropagation();
        if (hideBtn.classList.contains('je-already-hidden')) {
            JE.hiddenContent.unhideItem(state.jellyfinMediaId || `tmdb-${item.id}`);
            setHideButtonState(hideBtn, false, state.ctx);
            return;
        }
        JE.hiddenContent.confirmAndHide({
            itemId: state.jellyfinMediaId || '',
            name: escapeHtml(item.title || item.name),
            type: item.mediaType === 'tv' ? 'Series' : 'Movie',
            tmdbId: item.id,
            posterPath: item.posterPath || ''
        }, () => {
            card.style.display = 'none';
        });
    }

    /**
     * Click on the open overview (outside its request button / link): the same
     * action as the poster.
     * @param {MouseEvent} e
     * @param {Object} state - The card's state
     */
    function onOverviewClick(e, state) {
        const item = state.item;
        const target = /** @type {Element} */ (e.target);
        if (target.closest('.jellyseerr-request-button')) {
            return;
        }
        if (target.closest('.jellyseerr-overview-link')) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();

        if (state.linksAvailableToJellyfin) {
            goToJellyfinItem(state);
        } else if (item.mediaType === 'collection') {
            ui.showCollectionRequestModal(item.id, item.name || item.title, item);
        } else if (state.useMoreInfoModal && JE.jellyseerrMoreInfo) {
            const tmdbId = parseInt(item.id);
            const mediaType = item.mediaType;
            if (tmdbId && mediaType) {
                JE.jellyseerrMoreInfo.open(tmdbId, mediaType);
            }
        }
    }

    // How long after a tap that navigated to Jellyfin its synthetic click may
    // arrive and still count as that tap's (it normally follows within a few
    // frames; generous for a busy main thread).
    const TAP_CLICK_FOLLOW_MS = 1000;

    /**
     * Poster click. Runs the two steps the poster's two click listeners used
     * to run, in the same order: show the overview (desktop), then go to
     * Jellyfin or open the More Info modal. A click on a poster that links to
     * Jellyfin goes there once: on desktop both listeners used to navigate,
     * and on touch devices the click following a tap navigated again after
     * the tap had (either could add a second history entry).
     * @param {MouseEvent} e
     * @param {HTMLElement} card
     * @param {Object} state - The card's state
     */
    function onPosterClick(e, card, state) {
        // Desktop only: on touch devices the tap handler already handled it.
        if (!('ontouchstart' in window)) {
            if (state.linksAvailableToJellyfin) {
                e.preventDefault();
                e.stopPropagation();
                goToJellyfinItem(state);
                return;
            } else if (!state.overview) {
                e.preventDefault();
                e.stopPropagation();
                createOverview(state);
                closeOverviewOnOutsideClick(card, state);
            }
        }

        // The poster opens the modal (or, when the item is available and the
        // admin opted in, navigates straight to Jellyfin instead).
        if (state.linksAvailableToJellyfin) {
            e.preventDefault();
            e.stopPropagation();
            // The click that follows a tap the tap handler already navigated
            // for: handled as before, but it does not navigate a second time.
            const followsTap = state.tapNavigatedAt > 0
                && performance.now() - state.tapNavigatedAt < TAP_CLICK_FOLLOW_MS;
            state.tapNavigatedAt = 0;
            if (!followsTap) goToJellyfinItem(state);
        } else if (state.posterOpensModal) {
            e.preventDefault();
            e.stopPropagation();
            const tmdbId = parseInt(state.item.id);
            const mediaType = state.item.mediaType;
            if (tmdbId && mediaType) {
                JE.jellyseerrMoreInfo.open(tmdbId, mediaType);
            }
        }
    }

    /**
     * Delegated click (bubble phase) for every card in a container.
     * @param {HTMLElement} container
     * @param {MouseEvent} e
     */
    function onCardClick(container, e) {
        const hit = cardEventTarget(container, e);
        if (!hit) return;
        const { card, state, target } = hit;
        const hideBtn = inCard(card, target, '.je-hide-btn');
        if (hideBtn) {
            onHideButtonClick(e, /** @type {HTMLButtonElement} */ (hideBtn), card, state);
            return;
        }
        if (inCard(card, target, '.jellyseerr-collection-badge')) {
            const item = state.item;
            e.preventDefault();
            e.stopPropagation();
            ui.showCollectionRequestModal(item.collection.id, item.collection.name, item);
            return;
        }
        if (inCard(card, target, '.jellyseerr-overview')) {
            onOverviewClick(e, state);
            return;
        }
        if (inCard(card, target, '.jellyseerr-poster-image') === state.imageContainer) {
            onPosterClick(e, card, state);
        }
    }

    /**
     * Delegated keyboard activation of a focused poster: Enter / Space toggles
     * the overview (or goes to Jellyfin when the poster links there).
     * @param {HTMLElement} container
     * @param {KeyboardEvent} e
     */
    function onCardKeydown(container, e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const hit = cardEventTarget(container, e);
        if (!hit || inCard(hit.card, hit.target, '.jellyseerr-poster-image') !== hit.state.imageContainer) return;
        const state = hit.state;
        e.preventDefault();
        if (state.linksAvailableToJellyfin) {
            goToJellyfinItem(state);
        } else if (!state.overview) {
            createOverview(state);
        } else {
            removeOverview(state);
        }
    }

    /**
     * Delegated mouseenter / mouseleave (capture phase, as they don't bubble):
     * the hover overview on the poster area, and the hidden-item button's
     * "Unhide" title while hovered.
     * @param {HTMLElement} container
     * @param {MouseEvent} e
     * @param {boolean} entering - mouseenter (true) or mouseleave (false)
     */
    function onCardHoverBoundary(container, e, entering) {
        const target = e.target;
        if (!(target instanceof Element)) return;
        const isScalable = target.classList.contains('cardScalable');
        if (!isScalable && !target.classList.contains('je-hide-btn')) return;
        const hit = cardEventTarget(container, e);
        if (!hit) return;
        const state = hit.state;
        if (isScalable) {
            if (target !== state.cardScalable) return;
            // Desktop: hover to show/hide overview. Skipped when the poster just links
            // straight to Jellyfin — there's no request/status info worth previewing.
            if (!entering) {
                removeOverview(state);
            } else if (!state.overview && !state.linksAvailableToJellyfin) {
                createOverview(state);
            }
        } else if (target.classList.contains('je-already-hidden')) {
            /** @type {HTMLElement} */ (target).title = entering ? state.ctx.unhideLabel : state.ctx.hiddenLabel;
        }
    }

    /**
     * Touch: a tap (not a swipe) on the poster shows the overview; the next
     * tap on the overview acts on it. preventDefault() on the tap's touchend
     * suppresses the synthetic click so the fresh overview isn't immediately
     * activated. Swipes keep scrolling the results row natively.
     * @param {TouchEvent} e
     * @param {HTMLElement} imageContainer
     */
    function onPosterTap(e, imageContainer) {
        const card = /** @type {HTMLElement} */ (imageContainer.closest('.jellyseerr-card'));
        const state = card && cardStates.get(card);
        if (!state) return;
        const target = /** @type {Element} */ (e.target);
        if (target.closest('.jellyseerr-overview') || target.closest('.jellyseerr-request-button')) {
            return;
        }

        if (state.linksAvailableToJellyfin) {
            goToJellyfinItem(state);
            // Its synthetic click still reaches onPosterClick; it must not navigate again.
            state.tapNavigatedAt = performance.now();
            return;
        }

        if (!state.overview) {
            e.preventDefault();
            createOverview(state);
            closeOverviewOnOutsideClick(card, state);
        }
    }

    /**
     * Gives an element holding Seerr cards the delegated card listeners (once).
     * Bubble-phase listeners on the container see the same events, after the
     * same handlers inside the card, as the per-card listeners did.
     * @param {HTMLElement} container
     */
    function bindCardContainer(container) {
        if (boundContainers.has(container)) return;
        boundContainers.add(container);
        container.addEventListener('click', (e) => onCardClick(container, e));
        container.addEventListener('keydown', (e) => onCardKeydown(container, e));
        container.addEventListener('mouseenter', (e) => onCardHoverBoundary(container, e, true), true);
        container.addEventListener('mouseleave', (e) => onCardHoverBoundary(container, e, false), true);
        addDelegatedTouchTapListener(container, (el) => {
            const card = el.closest('.jellyseerr-card');
            const state = card && card.parentElement === container ? cardStates.get(card) : null;
            return state && state.imageContainer.contains(el) ? state.imageContainer : null;
        }, onPosterTap);
    }

    /**
     * Binds a card container on the first event that can reach one of its
     * cards. Runs at document capture, before the event reaches the container,
     * so the container's new listeners handle this very event too.
     * @param {Event} e
     */
    function bindCardContainersFrom(e) {
        const target = e.target;
        if (!(target instanceof Element)) return;
        const card = target.closest('.jellyseerr-card');
        const container = card && card.parentElement;
        if (container && !boundContainers.has(container) && cardStates.has(card)) {
            bindCardContainer(container);
        }
    }
    // mouseover precedes mouseenter, touchstart every touch, focusin every
    // keydown on a card, and click covers programmatic clicks.
    ['mouseover', 'touchstart', 'focusin', 'keydown', 'click'].forEach(type =>
        document.addEventListener(type, bindCardContainersFrom, { capture: true, passive: true }));

    ui.createJellyseerrCard = createJellyseerrCard;

    internal.createJellyseerrCard = createJellyseerrCard;

})(window.JellyfinEnhanced);
