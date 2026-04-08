// /js/elsewhere/reviews.js
(function (JE) {
    'use strict';

    JE.initializeReviewsScript = function () {
        const tmdbReviewsEnabled = JE.pluginConfig.ShowReviews && JE.pluginConfig.TmdbEnabled;
        const userReviewsEnabled = JE.pluginConfig.ShowUserReviews;
        if (!tmdbReviewsEnabled && !userReviewsEnabled) {
            console.log('🪼 Jellyfin Enhanced: Reviews feature disabled.');
            return;
        }

        const logPrefix = '🪼 Jellyfin Enhanced: Reviews:';

        function fetchReviews(tmdbId, mediaType) {
            const apiMediaType = mediaType === 'Series' ? 'tv' : 'movie';
            const url = `${ApiClient.getUrl(`/JellyfinEnhanced/tmdb/${apiMediaType}/${tmdbId}/reviews`)}?language=en-US&page=1`;
            return fetch(url, {
                headers: {
                    "X-Emby-Token": ApiClient.accessToken()
                }
            })
                .then(response => response.ok ? response.json() : Promise.reject(`API Error: ${response.status}`))
                .then(data => data.results || [])
                .catch(error => {
                    console.error(`${logPrefix} Failed to fetch reviews.`, error);
                    return null;
                });
        }

        /**
         * Fetches all user-written reviews for a TMDB item (aggregated across all users).
         */
        function fetchUserReviews(tmdbId, mediaType) {
            const apiMediaType = mediaType === 'Series' ? 'tv' : 'movie';
            const url = ApiClient.getUrl(`/JellyfinEnhanced/reviews/${apiMediaType}/${tmdbId}`);
            return fetch(url, {
                headers: { "X-Emby-Token": ApiClient.accessToken() }
            })
                .then(r => r.ok ? r.json() : Promise.reject(`API Error: ${r.status}`))
                .then(data => data.reviews || [])
                .catch(err => {
                    console.error(`${logPrefix} Failed to fetch user reviews.`, err);
                    return [];
                });
        }

        /**
         * Saves (creates or updates) the current user's review for a TMDB item.
         */
        async function saveUserReview(tmdbId, mediaType, content, rating) {
            const url = ApiClient.getUrl(`/JellyfinEnhanced/reviews/${mediaType}/${tmdbId}`);
            const body = { content, rating: rating || null };
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    "X-Emby-Token": ApiClient.accessToken(),
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(body)
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.message || `HTTP ${response.status}`);
            }
            return response.json();
        }

        /**
         * Deletes the current user's review for a TMDB item.
         */
        async function deleteUserReview(tmdbId, mediaType) {
            const url = ApiClient.getUrl(`/JellyfinEnhanced/reviews/${mediaType}/${tmdbId}`);
            const response = await fetch(url, {
                method: 'DELETE',
                headers: { "X-Emby-Token": ApiClient.accessToken() }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
        }

        /**
         * Admin moderation: deletes another user's review for a TMDB item.
         * Backed by DELETE /JellyfinEnhanced/reviews/admin/{userIdN}/{mediaType}/{tmdbId},
         * which is gated on IsAdministrator server-side. A 404 from the
         * server now means "no matching review to delete" (race with a
         * concurrent admin, already-deleted review, wrong target) — we
         * translate that into a human-readable Error so the caller can
         * show a sensible message.
         */
        async function adminDeleteUserReview(targetUserId, tmdbId, mediaType) {
            const userIdN = (targetUserId || '').replace(/-/g, '');
            const url = ApiClient.getUrl(`/JellyfinEnhanced/reviews/admin/${userIdN}/${mediaType}/${tmdbId}`);
            const response = await fetch(url, {
                method: 'DELETE',
                headers: { "X-Emby-Token": ApiClient.accessToken() }
            });
            if (response.status === 404) {
                throw new Error('No matching review to delete (it may have already been removed).');
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
        }

        const escapeHtml = JE.escapeHtml;

        /**
         * Shows a Jellyfin-native confirm dialog and returns a Promise<boolean>.
         * Prefers window.Dashboard.confirm (the built-in Jellyfin modal, which
         * auto-themes and handles keyboard nav). Falls back to window.confirm
         * on unusual clients where Dashboard is not exposed, so the feature
         * still works even if the platform surface changes.
         *
         * The native-confirm fallback prepends the title to the text because
         * window.confirm() has no title parameter — without this, an admin
         * deleting someone else's review would lose the "(admin)" context.
         */
        function jeConfirm(text, title) {
            return new Promise(resolve => {
                if (window.Dashboard && typeof window.Dashboard.confirm === 'function') {
                    try {
                        window.Dashboard.confirm(text, title, resolve);
                        return;
                    } catch (err) {
                        console.warn(`${logPrefix} Dashboard.confirm threw, falling back:`, err);
                    }
                }
                const combined = title ? `${title}\n\n${text}` : text;
                resolve(window.confirm(combined));
            });
        }

        /**
         * Shows a Jellyfin-native alert dialog. Falls back to window.alert on
         * clients without Dashboard. Used to surface delete failures so admins
         * get visible feedback instead of a silent console.error.
         */
        function jeAlert(text, title) {
            if (window.Dashboard && typeof window.Dashboard.alert === 'function') {
                try {
                    window.Dashboard.alert({ title: title || '', message: text || '' });
                    return;
                } catch (err) {
                    console.warn(`${logPrefix} Dashboard.alert threw, falling back:`, err);
                }
            }
            window.alert(title ? `${title}\n\n${text}` : text);
        }

        // Track which translation keys we've already warned about falling
        // back on, so a broken i18n system is visible in the console once per
        // key instead of spamming on every render.
        const _tFallbackWarned = new Set();

        /**
         * JE.t with an inline English fallback. Needed because the translation
         * loader prefers remote en.json over the bundled copy, which means a
         * brand-new key can return its literal name for one release cycle
         * until the remote catches up.
         *
         * Uses String.prototype.replace with a replacement *function* rather
         * than a string literal, because a raw replacement string treats `$&`,
         * `$'`, `` $` ``, `$1`-`$99`, and `$$` as backreferences. Jellyfin's
         * username regex doesn't allow `$`, so today's only param (a username)
         * is safe — but if a future caller interpolates a free-form string
         * into the fallback, the function form avoids the footgun.
         */
        function tWithFallback(key, fallback, params) {
            let result;
            try {
                result = JE.t(key, params);
            } catch (err) {
                console.warn(`${logPrefix} JE.t('${key}') threw, using fallback:`, err);
                result = null;
            }
            if (!result || result === key) {
                if (!_tFallbackWarned.has(key)) {
                    _tFallbackWarned.add(key);
                    console.warn(`${logPrefix} Missing translation key '${key}', using inline fallback.`);
                }
                let out = fallback;
                if (params) {
                    for (const [k, v] of Object.entries(params)) {
                        out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v));
                    }
                }
                return out;
            }
            return result;
        }

        /**
         * Converts markdown text to safe HTML. Escapes raw HTML before applying
         * markdown transforms so that API-sourced review content cannot inject tags.
         * @param {string} text - Raw markdown text from TMDB reviews.
         * @returns {string} HTML string safe for innerHTML assignment.
         */
        function parseMarkdown(text) {
            if (!text) return '';

            // Escape HTML first
            let html = escapeHtml(text);

            // Parse markdown elements
            // Bold (**text** or __text__)
            html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

            // Italic (*text* or _text_)
            html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
            html = html.replace(/_(.+?)_/g, '<em>$1</em>');

            // Strikethrough (~~text~~)
            html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

            // Inline code (`code`)
            html = html.replace(/`(.+?)`/g, '<code>$1</code>');

            // Links [text](url) - only allow http(s) schemes
            html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

            // Auto-link plain URLs (http:// or https://)
            // Match URLs that aren't already inside href attributes
            html = html.replace(/(^|[^"'>])(https?:\/\/[^\s<]+[^\s<.,;!?)])/gi, function(match, prefix, url) {
                // Don't linkify if already part of an anchor tag
                return prefix + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
            });

            // Process line by line for block elements
            const lines = html.split(/\r?\n/);
            const processed = [];
            let inBlockquote = false;
            let blockquoteLines = [];
            let inList = false;
            let listItems = [];

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const trimmedLine = line.trim();

                // Blockquotes (> text)
                if (trimmedLine.startsWith('&gt; ')) {
                    if (!inBlockquote) {
                        inBlockquote = true;
                        blockquoteLines = [];
                    }
                    blockquoteLines.push(trimmedLine.substring(5));
                    continue;
                } else if (inBlockquote) {
                    processed.push('<blockquote>' + blockquoteLines.join('<br>') + '</blockquote>');
                    inBlockquote = false;
                    blockquoteLines = [];
                }

                // Unordered lists (- item or * item)
                if (trimmedLine.match(/^[-*]\s+/)) {
                    if (!inList) {
                        inList = true;
                        listItems = [];
                    }
                    listItems.push('<li>' + trimmedLine.substring(2) + '</li>');
                    continue;
                } else if (inList) {
                    processed.push('<ul>' + listItems.join('') + '</ul>');
                    inList = false;
                    listItems = [];
                }

                // Headings (### text)
                if (trimmedLine.match(/^#{1,6}\s/)) {
                    const level = trimmedLine.match(/^#+/)[0].length;
                    const text = trimmedLine.substring(level + 1);
                    processed.push(`<h${level}>${text}</h${level}>`);
                    continue;
                }

                // Horizontal rule (--- or ***)
                if (trimmedLine.match(/^([-*]){3,}$/)) {
                    processed.push('<hr>');
                    continue;
                }

                // Regular line
                if (trimmedLine) {
                    processed.push(line);
                } else {
                    processed.push('<br>');
                }
            }

            // Close any open blocks
            if (inBlockquote) {
                processed.push('<blockquote>' + blockquoteLines.join('<br>') + '</blockquote>');
            }
            if (inList) {
                processed.push('<ul>' + listItems.join('') + '</ul>');
            }

            return processed.join('');
        }

        function createReviewElement(review) {
            const REVIEW_PREVIEW_LENGTH = 350;
            const reviewCard = document.createElement('div');
            reviewCard.className = 'tmdb-review-card';

            const content = review.content || 'No content available';
            const isLongReview = content.length > REVIEW_PREVIEW_LENGTH;
            const previewContent = isLongReview ? content.substring(0, REVIEW_PREVIEW_LENGTH) : content;

            const reviewDate = review.created_at ? new Date(review.created_at).toLocaleDateString(undefined, {
                year: 'numeric', month: 'short', day: 'numeric'
            }) : '';

            const rating = review.author_details?.rating;
            const ratingDisplay = rating ? `<span class="tmdb-review-rating">${JE.icon(JE.IconName.STAR)} ${rating}/10</span>` : '';

            reviewCard.innerHTML = `
                <div class="tmdb-review-header">
                    <div class="tmdb-review-author-info">
                        <strong class="tmdb-review-author">${escapeHtml(review.author || 'Anonymous')}</strong>
                        <span class="tmdb-review-date">${reviewDate}</span>
                    </div>
                    ${ratingDisplay}
                </div>
                <div class="tmdb-review-content-wrapper">
                    <p class="tmdb-review-text"></p>
                </div>
            `;

            const textElement = reviewCard.querySelector('.tmdb-review-text');
            textElement.innerHTML = parseMarkdown(previewContent) +
                (isLongReview ? `<span class="tmdb-review-toggle">${JE.t('reviews_read_more')}</span>` : '');

            return reviewCard;
        }

        /**
         * Builds the star display HTML for a 1–5 rating.
         * @param {number} rating - Integer 1 to 5.
         */
        function renderUserStarRating(rating) {
            if (!rating) return '';

            const stars = Array.from({ length: 5 }, (_, index) => {
                const filled = index < rating;
                return `<span class="je-user-star${filled ? ' je-user-star-filled' : ''}" aria-hidden="true">★</span>`;
            }).join('');

            return `<span class="je-user-star-rating">${stars}</span>`;
        }

        /**
         * Creates a review card for a user-written review (different border colour).
         * Own reviews get edit + delete. Non-own reviews get an admin delete button
         * when the viewer is an admin (for moderation).
         */
        function createUserReviewElement(review, currentUserId, viewerIsAdmin, onEditCallback, onDeleteCallback) {
            const REVIEW_PREVIEW_LENGTH = 350;
            const reviewCard = document.createElement('div');
            reviewCard.className = 'tmdb-review-card je-user-review-card';

            const content = review.content || '';
            const hasContent = content.length > 0;
            const isLongReview = content.length > REVIEW_PREVIEW_LENGTH;
            const previewContent = isLongReview ? content.substring(0, REVIEW_PREVIEW_LENGTH) : content;

            const reviewDate = review.updatedAt
                ? new Date(review.updatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
                : (review.createdAt ? new Date(review.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

            const ratingDisplay = review.rating
                ? `<span class="tmdb-review-rating je-user-review-rating">${renderUserStarRating(review.rating)}</span>`
                : '';

            // Avatar URL — Jellyfin serves user images at /Users/{id}/Images/Primary
            // userId stored in "N" format (no dashes); Jellyfin accepts both formats
            const avatarSrc = ApiClient.getUrl(`/Users/${review.userId}/Images/Primary`) + '?width=48&quality=90';

            const isOwn = review.userId.replace(/-/g, '') === currentUserId.replace(/-/g, '');
            const showModerationDelete = !isOwn && viewerIsAdmin;
            // Tooltips route through tWithFallback because JE.t returns the
            // raw key on miss (which is truthy), so a plain `JE.t(key) || 'X'`
            // would show literal `reviews_edit` until the remote en.json
            // catches up.
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
                        <img class="je-user-avatar" src="${escapeHtml(avatarSrc)}" alt="" onerror="this.style.display='none'">
                    </div>
                    <div class="tmdb-review-author-info">
                        <strong class="tmdb-review-author">${escapeHtml(review.userName || 'User')}</strong>
                        <span class="tmdb-review-date">${reviewDate}</span>
                    </div>
                    ${ratingDisplay}
                    ${actionButtons}
                </div>
                ${hasContent ? `
                <div class="tmdb-review-content-wrapper">
                    <p class="tmdb-review-text"></p>
                </div>` : ''}
            `;

            const textElement = reviewCard.querySelector('.tmdb-review-text');
            if (textElement) {
                textElement.innerHTML = parseMarkdown(previewContent) +
                    (isLongReview ? `<span class="tmdb-review-toggle">${JE.t('reviews_read_more')}</span>` : '');
            }

            // Store full content for toggling
            reviewCard.dataset.fullContent = content;

            if (isOwn) {
                reviewCard.querySelector('.je-review-edit-btn').addEventListener('click', () => onEditCallback(review));
                reviewCard.querySelector('.je-review-delete-btn').addEventListener('click', () => onDeleteCallback(review));
            } else if (showModerationDelete) {
                reviewCard.querySelector('.je-review-admin-delete-btn').addEventListener('click', () => onDeleteCallback(review));
            }

            return reviewCard;
        }

        /**
         * Creates and injects the inline review form (add / edit).
         * @param {object|null} existingReview - Existing review data when editing, null when adding.
         * @param {function} onSave - Called with (content, rating) when the user submits.
         * @param {function} onCancel - Called when the user cancels.
         */
        function createReviewForm(existingReview, onSave, onCancel) {
            const form = document.createElement('div');
            form.className = 'je-review-form';
            let currentRating = existingReview?.rating || 0;

            form.innerHTML = `
                ${existingReview ? '' : `<h4 class="je-review-form-title">${JE.t('reviews_add')}</h4>`}
                <div class="je-review-star-picker" role="radiogroup">
                    ${[1,2,3,4,5].map(n => `<button class="je-star-btn${currentRating >= n ? ' je-star-selected' : ''}" data-value="${n}" type="button">★</button>`).join('')}
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

            const starBtns = form.querySelectorAll('.je-star-btn');
            const clearBtn = form.querySelector('.je-star-clear-btn');
            const starLabel = form.querySelector('.je-star-label');
            const textarea = form.querySelector('.je-review-textarea');
            const charCount = form.querySelector('.je-review-char-count');
            const submitBtn = form.querySelector('.je-review-submit-btn');
            const cancelBtn = form.querySelector('.je-review-cancel-btn');
            const errorEl = form.querySelector('.je-review-form-error');

            function updateStars(value) {
                currentRating = value;
                starBtns.forEach(btn => {
                    const v = parseInt(btn.dataset.value, 10);
                    btn.classList.toggle('je-star-selected', v <= currentRating);
                });
                starLabel.textContent = currentRating > 0 ? `${currentRating}/5` : '';
            }

            updateStars(currentRating);

            starBtns.forEach(btn => {
                btn.addEventListener('click', () => updateStars(parseInt(btn.dataset.value, 10)));
                btn.addEventListener('mouseenter', () => starBtns.forEach(b => b.classList.toggle('je-star-hover', parseInt(b.dataset.value, 10) <= parseInt(btn.dataset.value, 10))));
                btn.addEventListener('mouseleave', () => starBtns.forEach(b => b.classList.remove('je-star-hover')));
            });

            clearBtn.addEventListener('click', () => updateStars(0));

            textarea.addEventListener('input', () => {
                charCount.textContent = textarea.value.length;
            });

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
                } catch (err) {
                    errorEl.textContent = JE.t('reviews_form_error_save');
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<span class="material-icons" aria-hidden="true">save</span>';
                }
            });

            cancelBtn.addEventListener('click', onCancel);

            return form;
        }

        function addReviewsToPage(reviews, userReviews, contextPage, tmdbId, tmdbMediaType, currentUser) {
            const existingSection = contextPage.querySelector('.tmdb-reviews-section');
            if (existingSection) {
                existingSection.remove();
            }

            // `currentUser` is resolved fresh by the caller (processPage /
            // refreshReviews) instead of read from the cached `JE.currentUser`
            // set once at plugin init. This matters for:
            //   1. Admin viewers on first render (race: JE.currentUser promise
            //      may not have resolved yet, so admin would briefly see no
            //      moderation buttons).
            //   2. In-session login switches (Jellyfin's SPA router doesn't
            //      re-init the plugin, so JE.currentUser stays stale as the
            //      previous user — a non-admin who logged in after an admin
            //      would see phantom admin controls, while the backend still
            //      blocks the actual delete with 403).
            // Using the live ApiClient session fixes both.
            const currentUserId = (currentUser?.Id) || ApiClient.getCurrentUserId() || '';
            const viewerIsAdmin = currentUser?.Policy?.IsAdministrator === true;
            const ownReview = userReviews.find(r => r.userId.replace(/-/g, '') === currentUserId.replace(/-/g, ''));
            const hasReviews = (reviews && reviews.length > 0) || userReviews.length > 0;

            let reviewsSection;

            if (hasReviews || true /* always show so users can add their own */) {
                reviewsSection = document.createElement('details');
                reviewsSection.className = 'detailSection tmdb-reviews-section';
                if (JE.currentSettings?.reviewsExpandedByDefault) {
                    reviewsSection.setAttribute('open', '');
                }

                const totalCount = (reviews ? reviews.length : 0) + userReviews.length;
                const summary = document.createElement('summary');
                summary.className = 'sectionTitle';
                summary.innerHTML = `${JE.t('reviews_title', { count: totalCount })} <i class="material-icons expand-icon">expand_more</i>`;
                reviewsSection.appendChild(summary);

                // ── "Write a Review" / "Edit Review" button bar ──────────────
                const actionBar = document.createElement('div');
                actionBar.className = 'je-review-action-bar';
                let writeBtn = null;

                if (userReviewsEnabled && !ownReview) {
                    writeBtn = document.createElement('button');
                    writeBtn.className = 'je-review-btn je-review-write-btn';
                    writeBtn.textContent = JE.t('reviews_add');
                    actionBar.appendChild(writeBtn);
                }
                reviewsSection.appendChild(actionBar);

                // ── Inline form placeholder (hidden until button clicked) ──────────
                const formPlaceholder = document.createElement('div');
                formPlaceholder.className = 'je-review-form-placeholder';
                reviewsSection.appendChild(formPlaceholder);

                const swipeContainer = document.createElement('div');
                swipeContainer.className = 'tmdb-review-swipe-container';

                // Render user reviews first (distinct border colour)
                userReviews.forEach(userReview => {
                    const card = createUserReviewElement(
                        userReview,
                        currentUserId,
                        viewerIsAdmin,
                        // Edit callback (own reviews only)
                        (r) => openForm(r),
                        // Delete callback — routes to self-delete for own reviews,
                        // admin moderation delete for others (admin viewers only).
                        async (r) => {
                            const isOwn = r.userId.replace(/-/g, '') === currentUserId.replace(/-/g, '');
                            const userName = r.userName || 'user';
                            const title = isOwn
                                ? tWithFallback('reviews_delete_title', 'Delete review')
                                : tWithFallback('reviews_admin_delete_title', 'Delete review (admin)');
                            const body = isOwn
                                ? tWithFallback('reviews_delete_confirm',
                                    'Delete your review for this item?')
                                : tWithFallback('reviews_admin_delete_confirm',
                                    'Delete this review by {user}? This cannot be undone.',
                                    { user: userName });
                            if (!(await jeConfirm(body, title))) return;
                            try {
                                if (isOwn) {
                                    await deleteUserReview(tmdbId, tmdbMediaType);
                                } else {
                                    await adminDeleteUserReview(r.userId, tmdbId, tmdbMediaType);
                                }
                                refreshReviews(contextPage);
                            } catch (e) {
                                // Surface the failure to the admin instead of
                                // silently failing: without this, a 403/404/500
                                // on the delete call would leave the review on
                                // screen with no feedback, making the admin
                                // believe the content was moderated when it
                                // wasn't.
                                console.error(`${logPrefix} Delete failed`, e);
                                const errTitle = tWithFallback('reviews_delete_error_title',
                                    'Delete failed');
                                const errBody = tWithFallback('reviews_delete_error_body',
                                    'Could not delete the review: {err}',
                                    { err: (e && e.message) ? e.message : 'Unknown error' });
                                jeAlert(errBody, errTitle);
                                // Re-fetch so the admin sees the real current state
                                // (in case the review was actually removed but the
                                // response was 500 on the way back, or a concurrent
                                // admin deleted it first).
                                refreshReviews(contextPage);
                            }
                        }
                    );
                    swipeContainer.appendChild(card);
                });

                // Render TMDB reviews after
                if (reviews && reviews.length > 0) {
                    reviews.slice(0, 10).forEach(review => {
                        swipeContainer.appendChild(createReviewElement(review));
                    });
                }

                reviewsSection.appendChild(swipeContainer);

                // ── Form open/close helpers ──────────────────────────────────────
                function openForm(existingReview) {
                    formPlaceholder.innerHTML = '';
                    const form = createReviewForm(
                        existingReview || null,
                        async (content, rating) => {
                            await saveUserReview(tmdbId, tmdbMediaType, content, rating);
                            refreshReviews(contextPage);
                        },
                        () => { formPlaceholder.innerHTML = ''; }
                    );
                    formPlaceholder.appendChild(form);
                    // Automatically open the details section so the form is visible
                    reviewsSection.setAttribute('open', '');
                    form.querySelector('.je-review-textarea').focus();
                }

                if (writeBtn) {
                    writeBtn.addEventListener('click', () => {
                        if (formPlaceholder.querySelector('.je-review-form')) {
                            formPlaceholder.innerHTML = '';
                        } else {
                            openForm(ownReview || null);
                        }
                    });
                }

                // ── Read-more toggle for TMDB reviews ─────────────────────────────
                swipeContainer.addEventListener('click', function (e) {
                    if (e.target.classList.contains('tmdb-review-toggle')) {
                        const textElement = e.target.parentElement;
                        const card = textElement.closest('.tmdb-review-card');
                        // Skip user review cards (they use dataset.fullContent)
                        if (card.classList.contains('je-user-review-card')) {
                            const full = card.dataset.fullContent || '';
                            if (textElement.classList.toggle('expanded')) {
                                textElement.innerHTML = parseMarkdown(full) + `<span class="tmdb-review-toggle">${JE.t('reviews_read_less')}</span>`;
                            } else {
                                textElement.innerHTML = parseMarkdown(full.substring(0, 350)) + `<span class="tmdb-review-toggle">${JE.t('reviews_read_more')}</span>`;
                            }
                            return;
                        }
                        const review = reviews.find(r => escapeHtml(r.author) === card.querySelector('.tmdb-review-author').textContent);
                        if (!review) return;
                        if (textElement.classList.toggle('expanded')) {
                            textElement.innerHTML = parseMarkdown(review.content) + `<span class="tmdb-review-toggle">${JE.t('reviews_read_less')}</span>`;
                        } else {
                            const previewContent = review.content.substring(0, 350);
                            textElement.innerHTML = parseMarkdown(previewContent) + `<span class="tmdb-review-toggle">${JE.t('reviews_read_more')}</span>`;
                        }
                    }
                });

                // Persist user's expand/collapse choice for future pages
                reviewsSection.addEventListener('toggle', function () {
                    try {
                        if (!window.JellyfinEnhanced) return;
                        const JE = window.JellyfinEnhanced;
                        JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
                        JE.currentSettings.reviewsExpandedByDefault = reviewsSection.open;
                        if (typeof JE.saveUserSettings === 'function') {
                            JE.saveUserSettings('settings.json', JE.currentSettings);
                        }
                    } catch (err) {
                        console.error(`${logPrefix} Failed to persist reviews expanded state`, err);
                    }
                });
            }

            const insertionAnchor =
                contextPage.querySelector('.streaming-lookup-container') ||
                contextPage.querySelector('.itemExternalLinks') ||
                contextPage.querySelector('.tagline');

            if (insertionAnchor && insertionAnchor.parentNode) {
                insertionAnchor.parentNode.insertBefore(reviewsSection, insertionAnchor.nextSibling);
            } else {
                console.error(`${logPrefix} Could not find a suitable anchor to insert reviews.`);
            }
        }

        /**
         * Re-fetches and re-renders the review section for the current page.
         */
        async function refreshReviews(contextPage) {
            try {
                const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                const userId = ApiClient.getCurrentUserId();
                if (!itemId || !userId) return;

                const item = JE.helpers?.getItemCached
                    ? await JE.helpers.getItemCached(itemId, { userId })
                    : await ApiClient.getItem(userId, itemId);
                const tmdbId = item?.ProviderIds?.Tmdb;
                const mediaType = item?.Type;
                if (!tmdbId || !(mediaType === 'Movie' || mediaType === 'Series')) return;

                const apiMediaType = mediaType === 'Series' ? 'tv' : 'movie';
                // Fetch the current user fresh alongside the review data so
                // admin status reflects the actual live session, not a
                // potentially-stale JE.currentUser captured at plugin init.
                const [tmdbReviews, userReviews, currentUser] = await Promise.all([
                    tmdbReviewsEnabled ? fetchReviews(tmdbId, mediaType) : Promise.resolve(null),
                    userReviewsEnabled ? fetchUserReviews(tmdbId, mediaType) : Promise.resolve([]),
                    ApiClient.getCurrentUser().catch(() => null),
                ]);

                const page = document.querySelector('#itemDetailPage:not(.hide)') || contextPage;
                addReviewsToPage(tmdbReviews, userReviews, page, tmdbId, apiMediaType, currentUser);
            } catch (err) {
                console.error(`${logPrefix} Failed to refresh reviews:`, err);
            }
        }

        function injectCss() {
            const styleId = 'tmdb-reviews-enhanced-styles';
            if (document.getElementById(styleId)) return;

            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .tmdb-reviews-section { margin: 2em 0 1em 0; display: flex !important; flex-direction: column;}
                .tmdb-reviews-section summary { cursor: pointer; display: flex; align-items: center; justify-content: space-between; user-select: none; -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; -webkit-tap-highlight-color: transparent;}
                .tmdb-reviews-section summary .expand-icon { color: rgba(255, 255, 255,.8);transition: transform 0.2s ease-in-out;}
                .tmdb-reviews-section[open] summary .expand-icon { transform: rotate(180deg);}
                .tmdb-review-swipe-container {
                    display: flex;
                    overflow-x: auto;
                    gap: 1.2em;
                    padding: 1em 0.5em;
                    scroll-snap-type: x mandatory;
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
                .je-user-review-card {
                    border-left-color: rgb(94, 213, 95);
                    background: rgba(10, 26, 10, 0.52);
                }
                @media (min-width: 768px) { .tmdb-review-card { flex-basis: 400px; } }
                .tmdb-review-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1em; }
                .je-user-review-header { align-items: center; gap: 0.75em; }
                .tmdb-review-author-info { display: flex; flex-direction: column; gap: 0.3em; flex: 1; }
                .tmdb-review-author { color: #fff; font-size: 1.1em; font-weight: 600; }
                .tmdb-review-date { color: #aaa; font-size: 0.9em; }
                .tmdb-review-rating { color: #ffd700; background: rgba(255, 215, 0, 0.1); padding: 0.2em 0.5em; border-radius: 4px; }
                .je-user-review-rating {
                    white-space: nowrap;
                    background: rgba(94, 213, 95, 0.12);
                    color: #ffd700;
                }
                .je-user-star-rating { display: inline-flex; align-items: center; gap: 0.08em; }
                .je-user-star { color: rgba(255, 255, 255, 0.28); font-size: 0.95em; }
                .je-user-star-filled { color: #ffd700; }
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
                .tmdb-review-toggle { color: rgb(1, 180, 228); font-weight: bold; cursor: pointer; text-decoration: underline; margin-left: 0.3em; }

                /* User avatar */
                .je-user-avatar-wrapper { flex-shrink: 0; }
                .je-user-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 2px solid rgb(94, 213, 95); display: block; }

                /* Action bar */
                .je-review-action-bar { padding: 0.5em 0.5em 0; display: flex; gap: 0.75em; }
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
                    background: none;
                    border: none;
                    cursor: pointer;
                    font-size: 1.6em;
                    color: rgba(255,255,255,0.2);
                    padding: 0;
                    line-height: 1;
                    transition: color 0.1s, transform 0.1s;
                }
                .je-star-btn:hover, .je-star-btn.je-star-hover, .je-star-btn.je-star-selected { color: #ffd700; }
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
            `;
            document.head.appendChild(style);
        }

        async function processPage(visiblePage) {
            if (!visiblePage || visiblePage.querySelector('.tmdb-reviews-section')) {
                return;
            }

            try {
                const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                const userId = ApiClient.getCurrentUserId();

                if (itemId && userId) {
                    const item = JE.helpers?.getItemCached
                        ? await JE.helpers.getItemCached(itemId, { userId })
                        : await ApiClient.getItem(userId, itemId);
                    const tmdbId = item?.ProviderIds?.Tmdb;
                    const mediaType = item?.Type;

                    if (tmdbId && mediaType && (mediaType === 'Movie' || mediaType === 'Series')) {
                        const apiMediaType = mediaType === 'Series' ? 'tv' : 'movie';
                        // See refreshReviews for why we resolve currentUser here
                        // instead of reading JE.currentUser — same race/staleness
                        // reasoning.
                        const [tmdbReviews, userReviews, currentUser] = await Promise.all([
                            tmdbReviewsEnabled ? fetchReviews(tmdbId, mediaType) : Promise.resolve(null),
                            userReviewsEnabled ? fetchUserReviews(tmdbId, mediaType) : Promise.resolve([]),
                            ApiClient.getCurrentUser().catch(() => null),
                        ]);
                        addReviewsToPage(tmdbReviews, userReviews, visiblePage, tmdbId, apiMediaType, currentUser);
                    }
                }
            } catch (error) {
                console.error(`${logPrefix} Error processing page:`, error);
            }
        }

        injectCss();

        // Use Emby.Page.onViewShow hook for reliable page navigation detection
        const unregister = JE.helpers.onViewPage(async (view, element, hash, itemPromise) => {
            // Check if feature is still enabled
            if (!JE?.pluginConfig?.ShowReviews && !JE?.pluginConfig?.ShowUserReviews) {
                unregister();
                return;
            }

            // Check if this might be an item detail page by looking at current URL or element
            const currentHash = window.location.hash;
            const hasItemId = currentHash.includes('id=') || (hash && hash.includes('id='));
            const isItemDetailElement = element && (
                element.id === 'itemDetailPage' ||
                element.classList?.contains('itemDetailPage')
            );

            if (!hasItemId && !isItemDetailElement) {
                return;
            }

            // Wait for the page to be visible
            await new Promise(resolve => setTimeout(resolve, 150));

            const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
            if (visiblePage) {
                processPage(visiblePage);
            }
        }, {
            pages: null, // Trigger on all pages, we'll filter by hash
            fetchItem: false,
            immediate: true // Process current page immediately on load
        });
    };
})(window.JellyfinEnhanced);

