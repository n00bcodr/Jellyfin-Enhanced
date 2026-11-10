/**
 * Shows the selected user's avatar above the manual-login password field and
 * progressively loads the user cards. Loaded pre-login as its own script.
 */
export interface LoginImageBridge { initializeLoginImage?: () => void }
export interface LoginClient { _currentUser?: { Id?: unknown } | null }

const MAX_ATTEMPTS = 200; // 20 s at 100 ms
const URL_PATTERN = /url\(['"]?(.*?)['"]?\)/;

/** The URL inside a CSS `background-image: url(...)` value, or null. */
export function backgroundUrl(style: string | null | undefined): string | null {
    const match = style?.match(URL_PATTERN);
    return match?.[1] ? match[1] : null;
}
/** Remove sizing/cache parameters and set the requested quality. */
export function cleanImageUrl(rawUrl: string, quality: number, origin: string): string {
    try {
        const url = new URL(rawUrl, origin);
        url.searchParams.delete('width');
        url.searchParams.delete('height');
        url.searchParams.delete('tag');
        url.searchParams.set('quality', quality.toString());
        return url.toString();
    } catch (error) {
        console.error('🪼 Jellyfin Enhanced: Login Image - Invalid URL', error);
        return rawUrl;
    }
}
export function baseImageUrl(fullUrl: string, origin: string): string {
    try {
        const url = new URL(fullUrl, origin);
        url.searchParams.delete('quality');
        return url.toString();
    } catch {
        return fullUrl;
    }
}

export function createLoginImage(readClient: () => LoginClient | undefined) {
    const imageCache = new Map<string, HTMLImageElement>();
    let attempts = 0;
    let attemptTimer: number | null = null;
    let updateTimeout: number | null = null;
    let initialUpdate: number | null = null;
    /** Resources bound to the login form currently decorated; replaced when Jellyfin renders a new form. */
    let attached: { input: HTMLInputElement; form: Element; dispose(): void } | null = null;
    let watchingRoutes = false;

    const origin = (): string => window.location.origin;
    const userImageUrl = (userId: string, quality = 40): string => `${origin()}/Users/${userId}/Images/Primary?quality=${quality}`;

    function isUserLoggedIn(): boolean {
        try {
            return !!readClient()?._currentUser?.Id;
        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: Login Image - Error checking login status.', error);
            return false;
        }
    }
    function nameInput(): HTMLInputElement | null {
        const input = document.getElementById('txtManualName');
        return input instanceof HTMLInputElement ? input : null;
    }
    const loginForm = (): HTMLElement | null => document.querySelector<HTMLElement>('.manualLoginForm');
    const userLabel = (): HTMLElement | null => loginForm()?.querySelector<HTMLElement>('label[for="txtManualName"]') ?? null;

    /** Exact (case-sensitive) username match without building a selector from user data (CHR-LOGIN-1). */
    function userCard(container: Element, username: string): HTMLElement | null {
        for (const card of container.querySelectorAll<HTMLElement>('.cardContent[data-username]')) {
            if (card.dataset.username === username) return card;
        }
        return null;
    }

    function preloadImage(url: string): Promise<HTMLImageElement> {
        return new Promise((resolve, reject) => {
            const cached = imageCache.get(url);
            if (cached) { resolve(cached); return; }
            const img = new Image();
            img.onload = () => { imageCache.set(url, img); resolve(img); };
            img.onerror = () => reject(new Error('Failed to load image'));
            img.src = url;
        });
    }

    function preloadAllUserImages(): void {
        const container = document.getElementById('divUsers');
        if (!container) return;
        container.querySelectorAll<HTMLElement>('.cardContent[data-username]').forEach(card => {
            const raw = backgroundUrl(card.querySelector<HTMLElement>('.cardImageContainer')?.style.backgroundImage);
            if (raw) preloadImage(cleanImageUrl(baseImageUrl(raw, origin()), 90, origin())).catch(() => { /* per-image best effort */ });
        });
    }

    function resetFormState(): void {
        const input = nameInput();
        const label = userLabel();
        if (input) input.style.display = '';
        if (label) label.style.display = '';
        document.getElementById('userProfileImageContainer')?.remove();
    }

    function displayProgressiveImage(base: string, username: string, imageContainer: HTMLElement,
        input: HTMLInputElement | null, label: HTMLElement | null): void {
        const highQualityUrl = cleanImageUrl(base, 90, origin());
        const img = document.createElement('img');
        img.alt = `Profile picture for ${username}`;
        img.style.cssText = `
            width: clamp(120px, 18vw, 180px);
            height: clamp(120px, 18vw, 180px);
            object-fit: cover;
            display: block;
            margin: 0 auto 20px auto;
        `;
        const hideName = (): void => {
            if (input) input.style.display = 'none';
            if (label) label.style.display = 'none';
        };
        if (imageCache.has(highQualityUrl)) {
            img.src = highQualityUrl;
            imageContainer.appendChild(img);
            hideName();
            return;
        }
        img.style.opacity = '0';
        img.style.transition = 'opacity 0.2s ease-in-out';
        let loaded = false;
        img.onerror = () => {
            console.warn('🪼 Jellyfin Enhanced: Login Image - Failed to load image');
            // A superseded image (another user picked meanwhile) must not reset the new one.
            if (img.isConnected) resetFormState();
        };
        img.onload = () => {
            if (loaded) return;
            loaded = true;
            img.style.opacity = '1';
            imageCache.set(highQualityUrl, img);
        };
        img.src = highQualityUrl;
        imageContainer.appendChild(img);
        hideName();
    }

    function updateProfilePicture(): void {
        const input = nameInput();
        const form = loginForm();
        const label = userLabel();
        if (!input || !form || form.classList.contains('hide')) { resetFormState(); return; }
        const username = input.value.trim();
        if (!username) { resetFormState(); return; }

        let userId: string | null = null;
        let base: string | null = null;
        const cards = document.getElementById('divUsers');
        const card = cards ? userCard(cards, username) : null;
        if (card) {
            userId = card.dataset.userid || null;
            const raw = backgroundUrl(card.querySelector<HTMLElement>('.cardImageContainer')?.style.backgroundImage);
            if (raw) base = baseImageUrl(raw, origin());
        }
        if (userId && !base) base = baseImageUrl(userImageUrl(userId, 40), origin());
        if (!base) { resetFormState(); return; }

        let imageContainer = document.getElementById('userProfileImageContainer');
        if (!imageContainer) {
            imageContainer = document.createElement('div');
            imageContainer.id = 'userProfileImageContainer';
            imageContainer.style.cssText = `
                text-align: center;
                margin-bottom: 20px;
                min-height: clamp(140px, 20vw, 200px);
            `;
            const inputContainer = form.querySelector('.inputContainer');
            if (inputContainer) form.insertBefore(imageContainer, inputContainer);
            else form.prepend(imageContainer);
        }
        imageContainer.innerHTML = '';
        displayProgressiveImage(base, username, imageContainer, input, label);
    }

    function debouncedUpdate(): void {
        if (updateTimeout !== null) clearTimeout(updateTimeout);
        updateTimeout = setTimeout(() => { updateTimeout = null; updateProfilePicture(); }, 50);
    }

    function applyProgressiveLoadingToCards(): void {
        const container = document.getElementById('divUsers');
        if (!container) return;
        container.querySelectorAll<HTMLElement>('.cardImageContainer').forEach((card, index) => {
            if (card.dataset.progressiveLoaded === 'true') return;
            card.dataset.progressiveLoaded = 'true';
            const raw = backgroundUrl(card.style.backgroundImage);
            if (!raw) return;
            const base = baseImageUrl(raw, origin());
            const lowQualityUrl = cleanImageUrl(base, 5, origin());
            const highQualityUrl = cleanImageUrl(base, 90, origin());
            // A separate blurred layer so the blur does not interfere with the hover transform.
            const blurOverlay = document.createElement('div');
            blurOverlay.className = 'progressive-blur-overlay';
            blurOverlay.style.cssText = `
                position: absolute;
                inset: 0;
                background-image: url("${lowQualityUrl}");
                background-size: cover;
                background-position: center;
                filter: blur(8px);
                transition: opacity 0.3s ease-in-out;
                pointer-events: none;
                z-index: 1;
                overflow: hidden;
            `;
            if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
            card.style.overflow = 'hidden';
            card.appendChild(blurOverlay);
            card.style.backgroundImage = `url("${highQualityUrl}")`;
            const highQuality = new Image();
            highQuality.onload = () => {
                blurOverlay.style.opacity = '0';
                setTimeout(() => { if (blurOverlay.parentNode) blurOverlay.remove(); }, 300);
            };
            highQuality.onerror = () => {
                console.warn(`🪼 Jellyfin Enhanced: Login Image - Card ${index + 1} high quality failed, keeping low quality`);
                card.style.backgroundImage = `url("${lowQualityUrl}")`;
                if (blurOverlay.parentNode) blurOverlay.remove();
            };
            highQuality.src = highQualityUrl;
        });
    }

    function cleanup(): void {
        attached?.dispose();
        attached = null;
        if (updateTimeout !== null) { clearTimeout(updateTimeout); updateTimeout = null; }
        if (initialUpdate !== null) { clearTimeout(initialUpdate); initialUpdate = null; }
    }

    /** Decorate one rendered login form. Re-running for the same form is a no-op; a new form replaces the old bindings. */
    function setupObservers(): boolean {
        const input = nameInput();
        const form = loginForm();
        if (!input || !form) {
            console.error('🪼 Jellyfin Enhanced: Login Image - Required elements not found.');
            return false;
        }
        if (attached && attached.input === input && attached.form === form && input.isConnected) return true;
        cleanup();
        const onInput = (): void => debouncedUpdate();
        input.addEventListener('input', onInput);
        // Form visibility changes, e.g. switching to passwordless login.
        const formObserver = new MutationObserver(() => {
            if (!form.classList.contains('hide')) debouncedUpdate();
            else resetFormState();
        });
        formObserver.observe(form, { attributes: true, attributeFilter: ['class'] });
        let cardsObserver: MutationObserver | null = null;
        const cards = document.getElementById('divUsers');
        if (cards) {
            cardsObserver = new MutationObserver(() => {
                applyProgressiveLoadingToCards();
                preloadAllUserImages();
            });
        }
        attached = {
            input, form,
            dispose() {
                input.removeEventListener('input', onInput);
                formObserver.disconnect();
                cardsObserver?.disconnect();
            }
        };
        // Pre-populated usernames are handled once the DOM settles.
        if (!form.classList.contains('hide')) {
            initialUpdate = setTimeout(() => { initialUpdate = null; updateProfilePicture(); }, 100);
        } else {
            resetFormState();
        }
        applyProgressiveLoadingToCards();
        preloadAllUserImages();
        if (cards && cardsObserver) cardsObserver.observe(cards, { childList: true, subtree: true });
        return true;
    }

    /**
     * Jellyfin renders a fresh login view after an in-app sign-out or server
     * selection, without reloading this script. Re-attach to that form whenever
     * the route changes while signed out (CHR-LOGIN-2).
     */
    function watchRoutes(): void {
        if (watchingRoutes) return;
        watchingRoutes = true;
        const recheck = (): void => {
            if (isUserLoggedIn()) { cleanup(); return; }
            if (attached && attached.input.isConnected && attached.input === nameInput()) return;
            attempts = 0;
            initializeLoginImage();
        };
        window.addEventListener('hashchange', recheck);
        window.addEventListener('popstate', recheck);
        document.addEventListener('viewshow', recheck);
    }

    function initializeLoginImage(): void {
        if (attemptTimer !== null) { clearTimeout(attemptTimer); attemptTimer = null; }
        // A signed-in page is not the login page; watch for a later sign-out.
        if (isUserLoggedIn()) { watchRoutes(); return; }
        if (nameInput() && loginForm()) {
            const fresh = !attached;
            if (setupObservers() && fresh) console.log('🪼 Jellyfin Enhanced: Login Image initialized');
            window.addEventListener('beforeunload', cleanup);
            watchRoutes();
            return;
        }
        attempts++;
        if (attempts < MAX_ATTEMPTS) attemptTimer = setTimeout(initializeLoginImage, 100);
        else watchRoutes();
    }

    return { initializeLoginImage };
}
