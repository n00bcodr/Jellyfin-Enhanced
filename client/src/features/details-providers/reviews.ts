/** TMDB, AniList and Jellyfin Enhanced user reviews on item details pages. */
import { api, bridge, browserTranslator, currentUserId, dashboard, detailsContext } from './host';
import type { ReviewsBridge } from './host';
import { detailsLease, hashItemId, lookupDetailsItem, visibleDetailPage } from './page';
import { pathSegment } from './links';
import { bool, decodeDetailsItem, errorShape, field, list, str } from './wire';
import type { DetailsItem } from './wire';
import {
    averageUserRating, decodeAnilistReviews, decodeTmdbReviews, decodeUserReviews, extractLinks, interpolate,
    memoUntilFailure, parseMarkdown, relink, renderUserStarRating, reviewDate, sameUser, starIconHtml, toPlainText, translationTargets
} from './review-domain';
import type { ExternalReview, UserReview } from './review-domain';

const JE = bridge<ReviewsBridge>('Reviews'), ctx = detailsContext(JE);
type ApiMediaType = 'movie' | 'tv';
interface ReviewTarget { tmdbKey: string; apiMediaType: ApiMediaType }
interface Viewer { id: string; isAdmin: boolean }
const REVIEW_PREVIEW_LENGTH = 350;

JE.initializeReviewsScript = function initializeReviewsScript() {
    const config = JE.pluginConfig;
    const tmdbReviewsEnabled = config.ShowReviews && config.TmdbEnabled;
    const userReviewsEnabled = config.ShowUserReviews;
    const anilistReviewsEnabled = config.ShowAnilistReviews;
    if (!tmdbReviewsEnabled && !userReviewsEnabled && !anilistReviewsEnabled) {
        console.log('🪼 Jellyfin Enhanced: Reviews feature disabled.');
        return;
    }
    const logPrefix = '🪼 Jellyfin Enhanced: Reviews:';
    let renderedOwners = new WeakMap<Element, ReturnType<typeof detailsLease>>();
    let pageLoads = new WeakMap<Element, object>();
    JE.session?.onUserChange('details-reviews', () => {
        document.querySelectorAll('.tmdb-reviews-section, .je-avg-user-rating-chip').forEach(section => section.remove());
        renderedOwners = new WeakMap();
        pageLoads = new WeakMap();
    });
    const escapeHtml = (value: string) => JE.escapeHtml(value);
    const markdown = (value: string) => parseMarkdown(value, escapeHtml);

    /**
     * Suppress the panel when the item has Spoiler Guard on and the admin
     * strips reviews. Season/Episode pages follow their series. Fails closed:
     * an unknown guard state or a failed check suppresses.
     */
    async function shouldSuppressForSpoilerMode(item: DetailsItem | null, mediaType: string | undefined): Promise<boolean> {
        try {
            if (mediaType !== 'Series' && mediaType !== 'Movie' && mediaType !== 'Season' && mediaType !== 'Episode') return false;
            if (!JE.pluginConfig.SpoilerBlurEnabled) return false;
            // Default-on when the field is missing (older plugin XML).
            if (JE.pluginConfig.SpoilerStripReviews === false) return false;
            const guard = ctx.peer('spoilerBlur');
            if (!guard) return false;
            if (typeof guard.whenLoaded === 'function') await guard.whenLoaded();
            if (typeof guard.isLoadOk === 'function' && !guard.isLoadOk()) {
                console.warn(`${logPrefix} Spoiler Guard state load failed; suppressing reviews fail-closed.`);
                return true;
            }
            // A user with HideReviews=false has asked to see reviews on guarded items.
            if (typeof guard.getUserPrefs === 'function') {
                const prefs = guard.getUserPrefs() || {};
                if (prefs.HideReviews === false) return false;
            }
            if (mediaType === 'Movie') {
                const inScope = guard.isMovieInScope;
                if (typeof inScope !== 'function') throw new TypeError('Spoiler Guard movie scope unavailable');
                return await inScope.call(guard, item?.Id || '');
            }
            const seriesKey = mediaType === 'Series' ? (item?.Id || '') : (item?.SeriesId || '');
            return !!(guard.isEnabledFor && guard.isEnabledFor(seriesKey));
        } catch (e) {
            console.warn(`${logPrefix} Spoiler Guard check failed; suppressing reviews:`, e);
            return true;
        }
    }

    function removeReviewsSection(page: ParentNode | null): void {
        try {
            const root: ParentNode = page || visibleDetailPage() || document;
            root.querySelector('.tmdb-reviews-section')?.remove();
            root.querySelector('.je-avg-user-rating-chip')?.remove();
        } catch (e) {
            console.warn(`${logPrefix} removeReviewsSection failed:`, e);
        }
    }

    /** TMDB reviews from the core response cache (same key shape as Seerr's helper); null on failure. */
    function fetchReviews(tmdbId: string, mediaType: string): Promise<ExternalReview[] | null> {
        const apiMediaType = mediaType === 'Series' ? 'tv' : 'movie';
        const id = pathSegment(tmdbId);
        const path = `/${apiMediaType}/${id}/reviews?language=en-US&page=1`;
        const url = `${api().getUrl(`/JellyfinEnhanced/tmdb/${apiMediaType}/${id}/reviews`)}?language=en-US&page=1`;
        return JE.core.api.fetch(url, { cacheKey: `tmdb:${path}` })
            .then(decodeTmdbReviews)
            .catch((error: unknown) => {
                console.error(`${logPrefix} Failed to fetch reviews.`, error);
                return null;
            });
    }
    /** Needs the AniList id the AniList metadata provider sets. */
    function fetchAnilistReviews(item: DetailsItem | null): Promise<ExternalReview[] | null> {
        const ids = item?.ProviderIds;
        const anilistId = parseInt(ids?.AniList || ids?.Anilist || '', 10);
        if (!anilistId) return Promise.resolve(null);
        const query = `anilistId=${anilistId}`;
        return JE.core.api.fetch(`${api().getUrl('/JellyfinEnhanced/anilist/reviews')}?${query}`, { cacheKey: `anilist:${query}` })
            .then(decodeAnilistReviews)
            .catch((error: unknown) => {
                console.error(`${logPrefix} Failed to fetch AniList reviews.`, error);
                return null;
            });
    }
    async function fetchExternalReviews(item: DetailsItem | null, tmdbKey: string, mediaType: string): Promise<ExternalReview[] | null> {
        if (mediaType !== 'Movie' && mediaType !== 'Series') return null;
        const [tmdb, anilist] = await Promise.all([
            tmdbReviewsEnabled ? fetchReviews(tmdbKey.split(':')[0] ?? '', mediaType) : null,
            anilistReviewsEnabled ? fetchAnilistReviews(item) : null
        ]);
        return tmdb || anilist ? [...(tmdb || []), ...(anilist || [])] : null;
    }

    /** The composite review key, encoded part by part for a request path. */
    const keyPath = (tmdbKey: string) => tmdbKey.split(':').map(pathSegment).join(':');
    /** All users' reviews for the title; null when they failed to load (a save upserts, so that is not "no review"). */
    function fetchUserReviews(tmdbKey: string, mediaType: ApiMediaType): Promise<UserReview[] | null> {
        return JE.core.api.plugin(`/reviews/${mediaType}/${keyPath(tmdbKey)}`)
            .then(decodeUserReviews)
            .catch((err: unknown) => {
                console.error(`${logPrefix} Failed to fetch user reviews.`, err);
                return null;
            });
    }
    /** Creates or updates the current user's review. Not idempotent: never retried. */
    async function saveUserReview(tmdbKey: string, mediaType: ApiMediaType, content: string, rating: number | null): Promise<unknown> {
        try {
            return await JE.core.api.plugin(`/reviews/${mediaType}/${keyPath(tmdbKey)}`, { method: 'POST', body: { content, rating: rating || null }, skipRetry: true });
        } catch (e) {
            const shape = errorShape(e);
            throw new Error(shape.responseMessage || shape.message);
        }
    }
    async function deleteUserReview(tmdbKey: string, mediaType: ApiMediaType): Promise<void> {
        await JE.core.api.plugin(`/reviews/${mediaType}/${keyPath(tmdbKey)}`, { method: 'DELETE', skipRetry: true });
    }
    /**
     * Admin moderation of another user's review (server-gated on
     * IsAdministrator). A 404 means there was no matching review to delete.
     */
    async function adminDeleteUserReview(targetUserId: string, tmdbKey: string, mediaType: ApiMediaType): Promise<void> {
        const userIdN = (targetUserId || '').replace(/-/g, '');
        try {
            await JE.core.api.plugin(`/reviews/admin/${pathSegment(userIdN)}/${mediaType}/${keyPath(tmdbKey)}`, { method: 'DELETE', skipRetry: true });
        } catch (e) {
            if (errorShape(e).status === 404) throw new Error('No matching review to delete (it may have already been removed).');
            throw e;
        }
    }

    /** Jellyfin's confirm dialog, else window.confirm with the title prepended. */
    function jeConfirm(message: string, title: string): Promise<boolean> {
        return new Promise(resolve => {
            const host = dashboard();
            if (host && typeof host.confirm === 'function') {
                try {
                    host.confirm(message, title, resolve);
                    return;
                } catch (err) {
                    console.warn(`${logPrefix} Dashboard.confirm threw, falling back:`, err);
                }
            }
            resolve(window.confirm(title ? `${title}\n\n${message}` : message));
        });
    }
    function jeAlert(message: string, title: string): void {
        const host = dashboard();
        if (host && typeof host.alert === 'function') {
            try {
                host.alert({ title: title || '', message: message || '' });
                return;
            } catch (err) {
                console.warn(`${logPrefix} Dashboard.alert threw, falling back:`, err);
            }
        }
        window.alert(title ? `${title}\n\n${message}` : message);
    }

    // Keys already warned about, so a broken i18n system shows once per key.
    const tFallbackWarned = new Set<string>();
    /**
     * JE.t with an inline English fallback: the loader prefers remote en.json,
     * so a brand-new key returns its literal name for one release cycle.
     */
    function tWithFallback(key: string, fallback: string, params?: Record<string, string | number>): string {
        let result: string | null;
        try {
            result = JE.t(key, params);
        } catch (err) {
            console.warn(`${logPrefix} JE.t('${key}') threw, using fallback:`, err);
            result = null;
        }
        if (!result || result === key) {
            if (!tFallbackWarned.has(key)) {
                tFallbackWarned.add(key);
                console.warn(`${logPrefix} Missing translation key '${key}', using inline fallback.`);
            }
            return interpolate(fallback, params);
        }
        return result;
    }

    const toggleHtml = (key: string) => `<span class="tmdb-review-toggle">${JE.t(key)}</span>`;
    function previewHtml(content: string, expanded: boolean): string {
        const long = content.length > REVIEW_PREVIEW_LENGTH;
        return markdown(long && !expanded ? content.substring(0, REVIEW_PREVIEW_LENGTH) : content)
            + (long ? toggleHtml(expanded ? 'reviews_read_less' : 'reviews_read_more') : '');
    }

    function createReviewElement(review: ExternalReview): HTMLDivElement {
        const reviewCard = document.createElement('div');
        reviewCard.className = 'tmdb-review-card';
        const isAnilist = review.source === 'anilist';
        if (isAnilist) reviewCard.classList.add('je-anilist-review-card');
        // Every card keeps its own text for read-more (an author name is not an identity).
        reviewCard.dataset.fullContent = review.content || '';

        const content = review.content || 'No content available';
        const date = reviewDate(review.created_at);
        const ratingDisplay = review.rating ? `<span class="tmdb-review-rating">${JE.icon(JE.IconName.STAR)} ${review.rating}</span>` : '';
        reviewCard.innerHTML = `
                <div class="tmdb-review-header">
                    <div class="tmdb-review-author-info">
                        <strong class="tmdb-review-author">${escapeHtml(review.author || 'Anonymous')}</strong>
                        <span class="tmdb-review-date">${escapeHtml(date)}</span>
                    </div>
                    ${ratingDisplay}
                </div>
                <div class="tmdb-review-content-wrapper">
                    <p class="tmdb-review-text"></p>
                </div>
            `;

        // Source tag with logo; only links to the original review on the expected host.
        const url = review.url || '';
        const sourceUrl = isAnilist ? (/^https:\/\/anilist\.co\//.test(url) ? url : '') : (/^https:\/\/www\.themoviedb\.org\//.test(url) ? url : '');
        const tag: HTMLElement = sourceUrl
            ? JE.helpers.createExternalLink(sourceUrl, { className: 'je-review-source', resetStyle: true })
            : Object.assign(document.createElement('span'), { className: 'je-review-source' });
        const logo = document.createElement('img');
        logo.src = JE.cdn.url('mdblist-logos', isAnilist ? 'anilist.png' : 'tmdb.png');
        logo.alt = '';
        logo.className = 'je-review-source-logo';
        logo.loading = 'lazy';
        tag.append(logo, isAnilist ? 'AniList' : 'TMDB');
        const dateEl = reviewCard.querySelector('.tmdb-review-date');
        if (date) dateEl?.append(Object.assign(document.createElement('span'), { textContent: '·' }));
        dateEl?.append(tag);

        const textElement = reviewCard.querySelector('.tmdb-review-text');
        if (textElement) textElement.innerHTML = previewHtml(content, false);
        attachTranslateButton(reviewCard, review.content || '');
        return reviewCard;
    }

    /** The user's Jellyfin language, as the UI strings use. */
    function getTranslationTargets() {
        let language = '';
        try { language = localStorage.getItem(`${currentUserId()}-language`) || ''; } catch { /* storage unavailable */ }
        return translationTargets(language || document.documentElement.lang || '');
    }
    /** Target languages the configured LibreTranslate offers, fetched once per page load; a failure is retried on the next render. */
    const getTranslationLanguages = memoUntilFailure(() => JE.core.api.plugin('/translate/languages', { skipRetry: true })
        .then(response => list(field(response, 'languages')).filter((code): code is string => typeof code === 'string')));
    /** Whether the browser's built-in translator can do English to the target (secure contexts only). */
    async function browserCanTranslate(target: string): Promise<boolean> {
        try {
            const translator = browserTranslator();
            if (!window.isSecureContext || !translator) return false;
            return (await translator.availability({ sourceLanguage: 'en', targetLanguage: target })) !== 'unavailable';
        } catch {
            return false;
        }
    }
    /** Line by line, so blank lines and paragraph breaks survive. */
    async function translateInBrowser(value: string, target: string): Promise<string> {
        const factory = browserTranslator();
        if (!factory) throw new Error('Browser translator unavailable');
        const translator = await factory.create({ sourceLanguage: 'en', targetLanguage: target });
        try {
            const lines: string[] = [];
            for (const line of value.split('\n')) lines.push(line.trim() ? await translator.translate(line) : line);
            return lines.join('\n');
        } finally {
            translator.destroy?.();
        }
    }
    /** 429 (with the wait, when given) means rate limited; translation_refused means LibreTranslate refused. */
    function translateFailedMessage(error: unknown): string {
        const shape = errorShape(error);
        if (shape.status === 429 || shape.responseCode === 'translation_rate_limited') {
            const seconds = shape.retryAfterSeconds;
            return seconds !== undefined && seconds > 0
                ? JE.t('reviews_translate_rate_limited_wait', { seconds })
                : JE.t('reviews_translate_rate_limited');
        }
        if (shape.responseCode === 'translation_refused') return JE.t('reviews_translate_refused');
        return JE.t('reviews_translate_failed');
    }

    /**
     * A Translate / Show original toggle under an English review: the
     * browser's translator when available, else the admin's LibreTranslate;
     * absent when neither offers the user's language.
     */
    function attachTranslateButton(card: HTMLElement, original: string): void {
        if (!JE.pluginConfig.ReviewTranslationEnabled || !original.trim()) return;
        const targets = getTranslationTargets();
        if (!targets) return;
        void Promise.all([
            browserCanTranslate(targets.browser),
            JE.pluginConfig.ReviewTranslationServer ? getTranslationLanguages().then(languages => languages.includes(targets.server), (error: unknown) => {
                console.warn(`${logPrefix} Translation languages unavailable; asking again on the next render.`, error); return false;
            }) : false
        ]).then(([browserOk, serverOk]) => {
            if (!browserOk && !serverOk) return;
            const textElement = card.querySelector<HTMLElement>('.tmdb-review-text');
            const parent = textElement?.parentElement;
            if (!textElement || !parent) return;
            const button = document.createElement('span');
            button.className = 'je-review-translate';
            const icon = Object.assign(document.createElement('span'), { className: 'je-msym-rounded', textContent: 'translate' });
            icon.setAttribute('aria-hidden', 'true');
            const label = Object.assign(document.createElement('span'), { className: 'je-review-translate-label' });
            button.append(icon, label);
            const setLabel = (key: string) => { label.textContent = JE.t(key); };
            setLabel('reviews_translate');
            parent.appendChild(button);

            const translateText = async (value: string): Promise<string> => {
                if (browserOk) {
                    try {
                        return await translateInBrowser(value, targets.browser);
                    } catch (e) {
                        if (!serverOk) throw e;
                    }
                }
                const response = await JE.core.api.plugin('/translate', { method: 'POST', body: { text: value, target: targets.server }, skipRetry: true });
                const translated = str(field(response, 'text'));
                if (translated === undefined) throw new Error('Invalid translation response');
                return translated;
            };
            const translate = async () => {
                const body = await translateText(toPlainText(original));
                const links = extractLinks(original);
                if (!links.length) return body;
                const labels = await translateText(links.map(link => link.label.replace(/\s+/g, ' ')).join('\n'));
                return relink(body, links, labels.split('\n'));
            };
            const show = (full: string) => {
                textElement.innerHTML = previewHtml(full, textElement.classList.contains('expanded'));
            };

            let busy = false;
            button.addEventListener('click', async () => {
                if (busy) return;
                if (card.dataset.showTranslated === '1') {
                    card.dataset.showTranslated = '0';
                    show(original);
                    setLabel('reviews_translate');
                    return;
                }
                if (card.dataset.translatedContent === undefined) {
                    busy = true;
                    setLabel('reviews_translating');
                    try {
                        card.dataset.translatedContent = await translate();
                    } catch (e) {
                        setLabel('reviews_translate');
                        JE.toast(translateFailedMessage(e));
                        return;
                    } finally {
                        busy = false;
                    }
                }
                card.dataset.showTranslated = '1';
                show(card.dataset.translatedContent ?? '');
                setLabel('reviews_show_original');
            });
        });
    }

    /**
     * A user-written review card. Own reviews get edit + delete; others get an
     * admin delete button when the viewer is an admin (the server enforces it).
     */
    function createUserReviewElement(review: UserReview, viewer: Viewer, onEdit: (review: UserReview) => void, onDelete: (review: UserReview) => void): HTMLDivElement {
        const reviewCard = document.createElement('div');
        reviewCard.className = 'tmdb-review-card je-user-review-card';
        const content = review.content || '';
        const date = reviewDate(review.updatedAt) || reviewDate(review.createdAt);
        const ratingDisplay = review.rating
            ? `<span class="tmdb-review-rating je-user-review-rating">${renderUserStarRating(review.rating)}</span>`
            : '';
        // Jellyfin serves user images at /Users/{id}/Images/Primary (both id formats).
        const avatarSrc = api().getUrl(`/Users/${pathSegment(review.userId)}/Images/Primary`) + '?width=48&quality=90';
        const isOwn = sameUser(review.userId, viewer.id);
        const showModerationDelete = !isOwn && viewer.isAdmin;
        // tWithFallback: JE.t returns the (truthy) key on a miss.
        const editTitle = tWithFallback('reviews_edit', 'Edit');
        const deleteTitle = tWithFallback('reviews_delete', 'Delete');
        const adminDeleteTitle = tWithFallback('reviews_admin_delete', 'Delete as admin');
        let actionButtons = '';
        if (isOwn) {
            actionButtons = `
                <div class="je-user-review-actions">
                    <button class="je-review-btn je-review-edit-btn" title="${escapeHtml(editTitle)}"><span class="material-icons" aria-hidden="true">edit</span></button>
                    <button class="je-review-btn je-review-delete-btn" title="${escapeHtml(deleteTitle)}"><span class="material-icons" aria-hidden="true">delete</span></button>
                </div>`;
        } else if (showModerationDelete) {
            actionButtons = `
                <div class="je-user-review-actions">
                    <button class="je-review-btn je-review-delete-btn je-review-admin-delete-btn" title="${escapeHtml(adminDeleteTitle)}"><span class="material-icons" aria-hidden="true">delete</span></button>
                </div>`;
        }
        reviewCard.innerHTML = `
                <div class="tmdb-review-header je-user-review-header">
                    <div class="je-user-review-avatar-wrapper">
                        <img class="je-user-avatar" src="${escapeHtml(avatarSrc)}" alt="">
                    </div>
                    <div class="tmdb-review-author-info">
                        <strong class="tmdb-review-author">${escapeHtml(review.userName || 'User')}</strong>
                        <span class="tmdb-review-date">${escapeHtml(date)}</span>
                    </div>
                    ${ratingDisplay}
                    ${actionButtons}
                </div>
                ${content.length > 0 ? `
                <div class="tmdb-review-content-wrapper">
                    <p class="tmdb-review-text"></p>
                </div>` : ''}
            `;
        const avatar = reviewCard.querySelector<HTMLImageElement>('.je-user-avatar');
        if (avatar) avatar.onerror = () => { avatar.style.display = 'none'; };
        const textElement = reviewCard.querySelector('.tmdb-review-text');
        if (textElement) textElement.innerHTML = previewHtml(content, false);
        // Store full content for toggling
        reviewCard.dataset.fullContent = content;
        if (isOwn) {
            reviewCard.querySelector('.je-review-edit-btn')?.addEventListener('click', () => onEdit(review));
            reviewCard.querySelector('.je-review-delete-btn')?.addEventListener('click', () => onDelete(review));
        } else if (showModerationDelete) {
            reviewCard.querySelector('.je-review-admin-delete-btn')?.addEventListener('click', () => onDelete(review));
        }
        return reviewCard;
    }

    /** The inline add / edit form. */
    function createReviewForm(existingReview: UserReview | null, onSave: (content: string, rating: number | null) => Promise<void>, onCancel: () => void): HTMLDivElement {
        const form = document.createElement('div');
        form.className = 'je-review-form';
        let currentRating = existingReview?.rating || 0;
        form.innerHTML = `
                ${existingReview ? '' : `<h4 class="je-review-form-title">${JE.t('reviews_add')}</h4>`}
                <div class="je-review-star-picker" role="radiogroup">
                    ${[1, 2, 3, 4, 5].map(n => `<button class="je-star-btn" data-value="${n}" type="button" aria-label="${n} stars">${starIconHtml(0)}</button>`).join('')}
                    <button class="je-star-clear-btn" type="button"><span class="material-icons" aria-hidden="true">close</span></button>
                    <span class="je-star-label"></span>
                </div>
                <textarea class="je-review-textarea" maxlength="2000">${escapeHtml(existingReview?.content || '')}</textarea>
                <div class="je-review-char-counter"><span class="je-review-char-count">${existingReview?.content?.length || 0}</span>/2000</div>
                <div class="je-review-form-btns">
                    <button class="je-review-btn je-review-submit-btn" type="button"><span class="material-icons" aria-hidden="true">save</span></button>
                    <button class="je-review-btn je-review-cancel-btn" type="button"><span class="material-icons" aria-hidden="true">close</span></button>
                </div>
                <div class="je-review-form-error" aria-live="polite"></div>
            `;
        const starBtns = form.querySelectorAll<HTMLButtonElement>('.je-star-btn');
        const required = <T extends Element>(selector: string): T => {
            const found = form.querySelector<T>(selector);
            if (!found) throw new Error(`Review form is missing ${selector}`);
            return found;
        };
        const clearBtn = required<HTMLButtonElement>('.je-star-clear-btn');
        const starLabel = required<HTMLElement>('.je-star-label');
        const textarea = required<HTMLTextAreaElement>('.je-review-textarea');
        const charCount = required<HTMLElement>('.je-review-char-count');
        const submitBtn = required<HTMLButtonElement>('.je-review-submit-btn');
        const cancelBtn = required<HTMLButtonElement>('.je-review-cancel-btn');
        const errorEl = required<HTMLElement>('.je-review-form-error');

        // The committed rating and the live hover preview.
        const setFill = (value: number) => {
            starBtns.forEach(btn => {
                const n = parseInt(btn.dataset.value ?? '0', 10);
                const pct = Math.round(Math.max(0, Math.min(1, value - (n - 1))) * 100);
                const fillSvg = btn.querySelector<SVGElement>('.je-star-icon-fill');
                if (fillSvg) fillSvg.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
            });
        };
        const updateStars = (value: number) => {
            currentRating = value;
            setFill(value);
            starLabel.textContent = currentRating > 0 ? `${currentRating}/5` : '';
        };
        // Left half of a star button = n - 0.5, right half = n.
        const valueForPointer = (btn: HTMLButtonElement, clientX: number) => {
            const n = parseInt(btn.dataset.value ?? '0', 10);
            const rect = btn.getBoundingClientRect();
            return (clientX - rect.left) < rect.width / 2 ? n - 0.5 : n;
        };
        updateStars(currentRating);
        starBtns.forEach(btn => {
            btn.addEventListener('click', event => updateStars(valueForPointer(btn, event.clientX)));
            btn.addEventListener('mousemove', event => setFill(valueForPointer(btn, event.clientX)));
            btn.addEventListener('mouseleave', () => setFill(currentRating));
        });
        clearBtn.addEventListener('click', () => updateStars(0));
        textarea.addEventListener('input', () => { charCount.textContent = String(textarea.value.length); });
        submitBtn.addEventListener('click', async () => {
            const content = textarea.value.trim();
            if (!content && !currentRating) {
                errorEl.textContent = JE.t('reviews_form_error_empty');
                return;
            }
            errorEl.textContent = '';
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<span class="material-icons" aria-hidden="true">hourglass_empty</span>';
            try {
                await onSave(content, currentRating || null);
            } catch {
                errorEl.textContent = JE.t('reviews_form_error_save');
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<span class="material-icons" aria-hidden="true">save</span>';
            }
        });
        cancelBtn.addEventListener('click', onCancel);
        return form;
    }

    function insertAverageChip(contextPage: Element, userReviews: UserReview[]): void {
        const average = averageUserRating(userReviews);
        contextPage.querySelector('.je-avg-user-rating-chip')?.remove();
        if (!average) return;
        const chip = document.createElement('div');
        chip.className = 'mediaInfoCriticRating mediaInfoItem je-avg-user-rating-chip';
        chip.title = tWithFallback('reviews_avg_rating_tooltip', 'Average rating from {count} user(s)', { count: average.count });
        chip.innerHTML = `<span class="je-msym-rounded starIcon" aria-hidden="true" style="color:#e91e8c;">person_heart</span>${escapeHtml(average.display)}`;
        // After the critic or star rating, else at the end of the info items.
        const anchor = contextPage.querySelector('.mediaInfoCriticRating') || contextPage.querySelector('.starRatingContainer');
        if (anchor?.parentNode) anchor.parentNode.insertBefore(chip, anchor.nextSibling);
        else contextPage.querySelector('.mediaInfoItems')?.appendChild(chip);
    }

    function addReviewsToPage(reviews: ExternalReview[] | null, fetched: UserReview[] | null, contextPage: Element, target: ReviewTarget, viewer: Viewer): void {
        removeReviewsSection(contextPage);
        const userReviews = fetched ?? [], userReviewsFailed = userReviewsEnabled && fetched === null; // failed: never offer to write
        // Average user rating next to the TMDB/RT rating chips
        if (userReviewsEnabled && userReviews.length > 0) insertAverageChip(contextPage, userReviews);

        const { tmdbKey, apiMediaType } = target;
        const ownReview = userReviews.find(review => sameUser(review.userId, viewer.id));
        // Always built, even with zero reviews, so users can add their own.
        const reviewsSection = document.createElement('details');
        reviewsSection.className = 'detailSection tmdb-reviews-section';
        const owner = detailsLease(JE.session, hashItemId() || '', contextPage);
        const current = () => reviewsSection.isConnected && owner.current();
        if (JE.currentSettings?.reviewsExpandedByDefault) reviewsSection.setAttribute('open', '');

        const totalCount = (reviews ? reviews.length : 0) + userReviews.length;
        const summary = document.createElement('summary');
        summary.className = 'sectionTitle';
        summary.innerHTML = `${JE.t('reviews_title', { count: totalCount })} <i class="material-icons expand-icon">expand_more</i>`;
        reviewsSection.appendChild(summary);

        // "Write a Review" button bar
        const actionBar = document.createElement('div');
        actionBar.className = 'je-review-action-bar';
        let writeBtn: HTMLButtonElement | null = null;
        if (userReviewsFailed) actionBar.appendChild(Object.assign(document.createElement('div'), { className: 'je-review-unavailable',
            textContent: tWithFallback('reviews_user_unavailable', "User reviews couldn't be loaded. Reload the page to try again.") }));
        else if (userReviewsEnabled && !ownReview) {
            writeBtn = document.createElement('button');
            writeBtn.className = 'je-review-btn je-review-write-btn';
            writeBtn.textContent = JE.t('reviews_add');
            actionBar.appendChild(writeBtn);
        }
        reviewsSection.appendChild(actionBar);

        // Inline form placeholder (hidden until opened)
        const formPlaceholder = document.createElement('div');
        formPlaceholder.className = 'je-review-form-placeholder';
        reviewsSection.appendChild(formPlaceholder);

        const swipeContainer = document.createElement('div');
        swipeContainer.className = 'tmdb-review-swipe-container';

        const openForm = (existingReview: UserReview | null) => {
            if (!current()) return;
            formPlaceholder.replaceChildren();
            const form = createReviewForm(existingReview, async (content, rating) => {
                if (!current()) return;
                await saveUserReview(tmdbKey, apiMediaType, content, rating);
                if (current()) void refreshReviews(contextPage);
            }, () => { formPlaceholder.replaceChildren(); });
            formPlaceholder.appendChild(form);
            // Open the details section so the form is visible
            reviewsSection.setAttribute('open', '');
            form.querySelector<HTMLTextAreaElement>('.je-review-textarea')?.focus();
        };
        const deleteReview = async (review: UserReview) => {
            if (!current()) return;
            const isOwn = sameUser(review.userId, viewer.id);
            const userName = review.userName || 'user';
            const title = isOwn
                ? tWithFallback('reviews_delete_title', 'Delete review')
                : tWithFallback('reviews_admin_delete_title', 'Delete review (admin)');
            const body = isOwn
                ? tWithFallback('reviews_delete_confirm', 'Delete your review for this item?')
                : tWithFallback('reviews_admin_delete_confirm', 'Delete this review by {user}? This cannot be undone.', { user: userName });
            if (!(await jeConfirm(body, title)) || !current()) return;
            try {
                if (isOwn) await deleteUserReview(tmdbKey, apiMediaType);
                else await adminDeleteUserReview(review.userId, tmdbKey, apiMediaType);
                if (current()) void refreshReviews(contextPage);
            } catch (e) {
                if (!current()) return;
                // A 403/404/500 must not leave the admin believing the content was moderated.
                console.error(`${logPrefix} Delete failed`, e);
                const errTitle = tWithFallback('reviews_delete_error_title', 'Delete failed');
                const errBody = tWithFallback('reviews_delete_error_body', 'Could not delete the review: {err}', { err: errorShape(e).message || 'Unknown error' });
                jeAlert(errBody, errTitle);
                // Re-fetch so the actual current state shows.
                void refreshReviews(contextPage);
            }
        };

        // User reviews first (distinct border colour), then TMDB/AniList
        for (const userReview of userReviews) swipeContainer.appendChild(createUserReviewElement(userReview, viewer, review => openForm(review), deleteReview));
        for (const review of (reviews ?? []).slice(0, 10)) swipeContainer.appendChild(createReviewElement(review));
        reviewsSection.appendChild(swipeContainer);

        writeBtn?.addEventListener('click', () => {
            if (formPlaceholder.querySelector('.je-review-form')) formPlaceholder.replaceChildren();
            else openForm(ownReview || null);
        });

        // Read-more toggle; a translated review expands to its translation.
        swipeContainer.addEventListener('click', event => {
            const toggle = event.target;
            if (!(toggle instanceof Element) || !toggle.classList.contains('tmdb-review-toggle')) return;
            const textElement = toggle.parentElement;
            const card = textElement?.closest<HTMLElement>('.tmdb-review-card');
            if (!textElement || !card) return;
            const full = (card.dataset.showTranslated === '1' ? card.dataset.translatedContent : card.dataset.fullContent) || '';
            const expanded = textElement.classList.toggle('expanded');
            textElement.innerHTML = expanded
                ? markdown(full) + toggleHtml('reviews_read_less')
                : markdown(full.substring(0, REVIEW_PREVIEW_LENGTH)) + toggleHtml('reviews_read_more');
        });

        // Persist the expand/collapse choice for future pages
        reviewsSection.addEventListener('toggle', () => {
            if (!current()) return;
            try {
                const settings = JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
                if (settings.reviewsExpandedByDefault !== reviewsSection.open) {
                    settings.reviewsExpandedByDefault = reviewsSection.open;
                    if (typeof JE.saveUserSettings === 'function') JE.saveUserSettings('settings.json', settings);
                }
            } catch (err) {
                console.error(`${logPrefix} Failed to persist reviews expanded state`, err);
            }
        });

        const insertionAnchor = contextPage.querySelector('.streaming-lookup-container')
            || contextPage.querySelector('.itemExternalLinks')
            || contextPage.querySelector('.tagline');
        if (insertionAnchor?.parentNode) insertionAnchor.parentNode.insertBefore(reviewsSection, insertionAnchor.nextSibling);
        else console.error(`${logPrefix} Could not find a suitable anchor to insert reviews.`);
    }

    /** The review key for the item: title for Movie/Series, series + season/episode otherwise. */
    async function resolveTarget(item: DetailsItem | null, mediaType: string | undefined, seriesLookup: (seriesId: string) => Promise<DetailsItem | null>): Promise<ReviewTarget | null> {
        if (!item) return null;
        if (mediaType === 'Movie' || mediaType === 'Series') {
            const tmdbId = item.ProviderIds.Tmdb;
            return tmdbId ? { tmdbKey: tmdbId, apiMediaType: mediaType === 'Movie' ? 'movie' : 'tv' } : null;
        }
        if (mediaType !== 'Season' && mediaType !== 'Episode') return null;
        // The show's TMDB id lives on the parent Series.
        let seriesTmdbId = item.SeriesProviderIds.Tmdb;
        if (!seriesTmdbId && item.SeriesId) {
            try { seriesTmdbId = (await seriesLookup(item.SeriesId))?.ProviderIds.Tmdb; } catch { /* no series */ }
        }
        if (!seriesTmdbId || item.IndexNumber == null) return null;
        if (mediaType === 'Season') return { tmdbKey: `${seriesTmdbId}:s${item.IndexNumber}`, apiMediaType: 'tv' };
        if (item.ParentIndexNumber == null) return null;
        return { tmdbKey: `${seriesTmdbId}:s${item.ParentIndexNumber}:e${item.IndexNumber}`, apiMediaType: 'tv' };
    }

    /**
     * The viewer resolved fresh on every render, so an in-session login switch
     * cannot show admin controls to a non-admin (the server blocks it anyway).
     */
    async function fetchViewer(): Promise<Viewer> {
        const client = api();
        let user: unknown = null;
        try { user = client.getCurrentUser ? await client.getCurrentUser() : null; } catch { user = null; }
        return {
            id: str(field(user, 'Id')) || client.getCurrentUserId() || '',
            isAdmin: bool(field(field(user, 'Policy'), 'IsAdministrator')) === true
        };
    }

    /**
     * Loads and renders the item's reviews into `page`. Applied only while the
     * same item's page is still the visible one for the same session.
     */
    async function loadInto(page: Element, seriesLookup: (userId: string, seriesId: string) => Promise<DetailsItem | null>, force = false): Promise<void> {
        const itemId = hashItemId();
        const userId = currentUserId();
        if (!itemId || !userId) return;
        const lease = detailsLease(JE.session, itemId, page);
        const request = {};
        pageLoads.set(page, request);
        const current = () => lease.current() && pageLoads.get(page) === request;
        const item = await lookupDetailsItem(JE.helpers, itemId, true, userId);
        // A superseded visit stops before any review request.
        if (!current()) return;
        const mediaType = item?.Type;
        // Missing metadata cannot establish the policy for retained private text.
        if (!item || !mediaType) {
            removeReviewsSection(page);
            renderedOwners.delete(page);
            return;
        }
        if (await shouldSuppressForSpoilerMode(item, mediaType)) {
            if (current()) { removeReviewsSection(page); renderedOwners.delete(page); }
            return;
        }
        if (!current()) return;
        if (!force && renderedOwners.get(page)?.current() && page.querySelector('.tmdb-reviews-section')) return;
        const target = await resolveTarget(item, mediaType, seriesId => seriesLookup(userId, seriesId));
        if (!target || !mediaType || !current()) return;
        const [externalReviews, userReviews, viewer] = await Promise.all([
            // TMDB and AniList reviews are movie/series only
            fetchExternalReviews(item, target.tmdbKey, mediaType),
            userReviewsEnabled ? fetchUserReviews(target.tmdbKey, target.apiMediaType) : Promise.resolve([]),
            fetchViewer()
        ]);
        if (!current()) return;
        addReviewsToPage(externalReviews, userReviews, page, target, viewer);
        renderedOwners.set(page, lease);
        // Bust the poster tag cache for this item so the overlay updates
        const invalidateTags = ctx.peer('invalidateUserReviewTagCache'); if (typeof invalidateTags === 'function') invalidateTags(target.tmdbKey);
    }

    /** Re-fetches and re-renders after a mutation (series looked up directly, as before). */
    async function refreshReviews(contextPage: Element): Promise<void> {
        try {
            await loadInto(visibleDetailPage() || contextPage, async (userId, seriesId) => decodeDetailsItem(await api().getItem(userId, seriesId)), true);
        } catch (err) {
            console.error(`${logPrefix} Failed to refresh reviews:`, err);
        }
    }
    async function processPage(visiblePage: Element | null): Promise<void> {
        if (!visiblePage) return;
        if (!renderedOwners.get(visiblePage)?.current()) {
            removeReviewsSection(visiblePage);
            renderedOwners.delete(visiblePage);
        }
        try {
            // Series lookups go through the shared item cache.
            await loadInto(visiblePage, (userId, seriesId) => lookupDetailsItem(JE.helpers, seriesId, true, userId));
        } catch (error) {
            console.error(`${logPrefix} Error processing page:`, error);
        }
    }
    function injectCss(): void {
        const styleId = 'tmdb-reviews-enhanced-styles';
        if (document.getElementById(styleId)) return;
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = REVIEWS_CSS;
        document.head.appendChild(style);
    }

    injectCss();
    // Emby.Page.onViewShow for reliable page navigation detection
    const unregister = JE.helpers.onViewPage(async (_view, element, hash) => {
        if (!JE.pluginConfig.ShowReviews && !JE.pluginConfig.ShowUserReviews && !JE.pluginConfig.ShowAnilistReviews) {
            unregister?.();
            return;
        }
        const hasItemId = window.location.hash.includes('id=') || (typeof hash === 'string' && hash.includes('id='));
        const isItemDetailElement = !!element && (element.id === 'itemDetailPage' || element.classList.contains('itemDetailPage'));
        if (!hasItemId && !isItemDetailElement) return;
        // Wait for the page to be visible
        await new Promise<void>(resolve => setTimeout(resolve, 150));
        const visiblePage = visibleDetailPage();
        if (visiblePage) void processPage(visiblePage);
    }, { pages: null, fetchItem: false, immediate: true });
};


const REVIEWS_CSS = `
                .je-msym-rounded {
                    font-family: 'JE Material Symbols Rounded';
                    font-weight: normal;
                    font-style: normal;
                    line-height: 1;
                    letter-spacing: normal;
                    text-transform: none;
                    display: inline-block;
                    white-space: nowrap;
                    word-wrap: normal;
                    direction: ltr;
                    -webkit-font-feature-settings: 'liga';
                    font-feature-settings: 'liga';
                    -webkit-font-smoothing: antialiased;
                }
                /* Some themes style .detailSection as a grid, and a flex/grid
                   item's default min-width is auto — so this section's
                   horizontally-scrolling card row can report its full
                   unscrolled width as intrinsic size and blow out past the
                   viewport. width:100%+min-width:0 here and on the swipe
                   container below keep both pinned to the available width. */
                .tmdb-reviews-section { margin: 2em 0 1em 0; display: flex !important; flex-direction: column; width: 100%; min-width: 0;}
                .tmdb-reviews-section summary { cursor: pointer; display: flex; align-items: center; justify-content: space-between; user-select: none; -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; -webkit-tap-highlight-color: transparent;}
                .tmdb-reviews-section summary .expand-icon { color: rgba(255, 255, 255,.8);transition: transform 0.2s ease-in-out;}
                .tmdb-reviews-section[open] summary .expand-icon { transform: rotate(180deg);}
                .tmdb-review-swipe-container {
                    display: flex;
                    overflow-x: auto;
                    gap: 1.2em;
                    padding: 1em 0.5em;
                    scroll-snap-type: x mandatory;
                    width: 100%;
                    min-width: 0;
                }
                .tmdb-review-card {
                    flex: 0 0 85%;
                    max-width: 500px;
                    background: rgba(0, 0, 0, 0.3);
                    border-radius: 8px;
                    border-left: 4px solid rgb(1, 180, 228);
                    padding: 1.5em;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
                    scroll-snap-align: start;
                    display: flex;
                    flex-direction: column;
                }
                .je-anilist-review-card { border-left-color: rgb(61, 180, 242); }
                .je-review-source { color: rgb(1, 180, 228); display: inline-flex; align-items: center; gap: 0.3em; }
                .je-anilist-review-card .je-review-source { color: rgb(61, 180, 242); }
                .je-review-source-logo { width: 1.1em; height: 1.1em; border-radius: 3px; }
                .je-user-review-card {
                    border-left-color: rgb(94, 213, 95);
                    background: rgba(10, 26, 10, 0.52);
                }
                @media (min-width: 768px) { .tmdb-review-card { flex-basis: 400px; } }
                .tmdb-review-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1em; }
                .je-user-review-header { align-items: center; gap: 0.75em; }
                .tmdb-review-author-info { display: flex; flex-direction: column; gap: 0.3em; flex: 1; }
                .tmdb-review-author { color: #fff; font-size: 1.1em; font-weight: 600; }
                .tmdb-review-date { color: #aaa; font-size: 0.9em; display: flex; align-items: center; gap: 0.4em; }
                .tmdb-review-rating { display: inline-flex; align-items: center; color: #ffd700; background: rgba(255, 215, 0, 0.1); padding: 0.2em 0.5em; border-radius: 4px; gap: 0.2em;}
                .je-user-review-rating {
                    white-space: nowrap;
                    background: rgba(94, 213, 95, 0.12);
                    color: #ffd700;
                }
                .je-user-star-rating { display: inline-flex; align-items: center; gap: 0.02em; }
                .je-star-icon { position: relative; display: inline-block; width: 1em; height: 1em; color: rgba(255, 255, 255, 0.28); }
                .je-star-icon svg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: block; }
                .je-star-icon-fill { color: #ffd700; }
                .je-user-star-rating .je-star-icon { width: 1.05em; height: 1.05em; vertical-align: middle; }
                .tmdb-review-content-wrapper { flex-grow: 1; line-height: 1.7; overflow-y: auto; color: #ddd; font-size: 0.95em; }
                .tmdb-review-text { word-wrap: break-word; }
                .tmdb-review-text strong { color: #fff; font-weight: 600; }
                .tmdb-review-text em { font-style: italic; color: #e0e0e0; }
                .tmdb-review-text del { text-decoration: line-through; opacity: 0.7; }
                .tmdb-review-text code { background: rgba(255, 255, 255, 0.1); padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 0.9em; color: #ffa500; }
                .tmdb-review-text blockquote { border-left: 3px solid rgb(1, 180, 228); padding-left: 1em; margin: 0.8em 0; color: #aaa; font-style: italic; }
                .tmdb-review-text h1, .tmdb-review-text h2, .tmdb-review-text h3, .tmdb-review-text h4, .tmdb-review-text h5, .tmdb-review-text h6 { color: #fff; margin: 0.8em 0 0.4em 0; font-weight: 600; }
                .tmdb-review-text h1 { font-size: 1.5em; }
                .tmdb-review-text h2 { font-size: 1.3em; }
                .tmdb-review-text h3 { font-size: 1.15em; }
                .tmdb-review-text h4, .tmdb-review-text h5, .tmdb-review-text h6 { font-size: 1.05em; }
                .tmdb-review-text ul, .tmdb-review-text ol { margin: 0.5em 0; padding-left: 1.5em; }
                .tmdb-review-text li { margin: 0.3em 0; }
                .tmdb-review-text hr { border: none; border-top: 1px solid rgba(255, 255, 255, 0.2); margin: 1em 0; }
                .tmdb-review-text a { color: rgb(1, 180, 228); text-decoration: underline; }
                .tmdb-review-text a:hover { color: rgb(50, 200, 250); }
                /* emby-linkbutton gives links button padding, margin and weight, which breaks line spacing */
                .tmdb-review-text a[is="emby-linkbutton"] { display: inline !important; padding: 0 !important; margin: 0 !important; min-width: 0 !important; font-weight: inherit !important; vertical-align: baseline !important; }
                .tmdb-review-toggle { color: rgb(1, 180, 228); font-weight: bold; cursor: pointer; text-decoration: underline; margin-left: 0.3em; }
                .je-review-translate { display: inline-flex; align-items: center; gap: 0.3em; margin-top: 0.5em; color: rgb(1, 180, 228); font-size: 0.9em; cursor: pointer; }
                .je-review-translate .je-msym-rounded { font-size: 1.3em; }
                .je-review-translate-label { text-decoration: underline; }

                /* User avatar */
                .je-user-avatar-wrapper { flex-shrink: 0; }
                .je-user-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 2px solid rgb(94, 213, 95); display: block; }

                /* Action bar */
                .je-review-action-bar { padding: 0.5em 0.5em 0; display: flex; gap: 0.75em; } .je-review-unavailable { opacity: 0.75; font-size: 0.9em; }
                .je-user-review-actions { display: flex; gap: 0.5em; flex-shrink: 0; }

                /* Shared button style */
                .je-review-btn {
                    background: rgba(255,255,255,0.08);
                    border: 1px solid rgba(255,255,255,0.15);
                    border-radius: 6px;
                    color: #fff;
                    cursor: pointer;
                    font-size: 0.85em;
                    padding: 0.35em 0.9em;
                    transition: background 0.15s;
                }
                .je-review-btn:hover { background: rgba(255,255,255,0.15); }
                .je-review-write-btn { border-color: rgb(94, 213, 95); color: rgb(94, 213, 95); }
                .je-review-write-btn:hover { background: rgba(94, 213, 95, 0.15); }
                .je-review-edit-btn, .je-review-delete-btn, .je-review-submit-btn, .je-review-cancel-btn {
                    width: 2.4em;
                    height: 2.4em;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    padding: 0;
                }
                .je-review-edit-btn .material-icons, .je-review-delete-btn .material-icons, .je-review-submit-btn .material-icons, .je-review-cancel-btn .material-icons, .je-star-clear-btn .material-icons { font-size: 18px; }
                .je-review-edit-btn { border-color: rgb(94, 213, 95); color: rgb(94, 213, 95); }
                .je-review-delete-btn { border-color: rgb(244, 67, 54); color: rgb(244, 67, 54); }
                .je-review-delete-btn:hover { background: rgba(244, 67, 54, 0.15); }

                /* Inline review form */
                .je-review-form-placeholder { padding: 0 0.5em; }
                .je-review-form {
                    background: rgba(0,0,0,0.4);
                    border: 1px solid rgba(94, 213, 95, 0.4);
                    border-radius: 8px;
                    padding: 1.2em;
                    margin: 0.75em 0;
                    display: flex;
                    flex-direction: column;
                    gap: 0.75em;
                }
                .je-review-form-title { margin: 0; font-size: 1em; color: #fff; font-weight: 600; }
                .je-review-star-picker { display: flex; align-items: center; gap: 0.3em; }
                .je-star-btn {
                    display: inline-flex;
                    align-items: center;
                    background: none;
                    border: none;
                    cursor: pointer;
                    padding: 0;
                    line-height: 1;
                    transition: transform 0.1s;
                }
                .je-star-btn .je-star-icon { width: 1.6em; height: 1.6em; pointer-events: none; }
                .je-star-btn:hover { transform: scale(1.2); }
                .je-star-clear-btn {
                    background: rgba(255,255,255,0.08);
                    border: 1px solid rgba(255,255,255,0.15);
                    border-radius: 6px;
                    cursor: pointer;
                    color: rgba(255,255,255,0.7);
                    width: 2.2em;
                    height: 2.2em;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    padding: 0;
                }
                .je-star-clear-btn:hover { background: rgba(255,255,255,0.15); }
                .je-star-label { color: #ffd700; font-size: 0.9em; margin-left: 0.25em; min-width: 2.5em; }
                .je-review-textarea {
                    width: 100%;
                    min-height: 100px;
                    resize: vertical;
                    background: rgba(255,255,255,0.06);
                    border: 1px solid rgba(255,255,255,0.15);
                    border-radius: 6px;
                    color: #fff;
                    font-size: 0.95em;
                    padding: 0.6em 0.8em;
                    box-sizing: border-box;
                    font-family: inherit;
                    line-height: 1.5;
                }
                .je-review-textarea:focus { outline: none; border-color: rgb(94, 213, 95); }
                .je-review-char-counter { font-size: 0.8em; color: rgba(255,255,255,0.4); text-align: right; }
                .je-review-form-btns { display: flex; gap: 0.75em; }
                .je-review-submit-btn { border-color: rgb(94, 213, 95); color: rgb(94, 213, 95); }
                .je-review-submit-btn:hover { background: rgba(94, 213, 95, 0.15); }
                .je-review-submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
                .je-review-form-error { color: rgb(244, 67, 54); font-size: 0.85em; min-height: 1em; }

                /* Average user rating chip in item details */
                .je-avg-user-rating-chip .starIcon { color: #e91e8c !important; }
                /* Remove the padding coming from using critic rating container */
                .je-avg-user-rating-chip { padding-left: 0 !important; }
                /* Remove the % added by ElegantFin Theme */
                .mediaInfoCriticRating.mediaInfoItem.je-avg-user-rating-chip::after {
                    content: "";
                }
            `;
