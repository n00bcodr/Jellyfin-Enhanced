// /js/reviews.js
(function (JE) {
    'use strict';

    JE.initializeReviewsScript = function () {
        if (!JE.pluginConfig.ShowReviews || !JE.pluginConfig.TMDB_API_KEY) {
            console.log('🪼 Jellyfin Enhanced: Reviews feature disabled or TMDB API key not set.');
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

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
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
            const ratingDisplay = rating ? `<span class="tmdb-review-rating">⭐ ${rating}/10</span>` : '';

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
            textElement.innerHTML = escapeHtml(previewContent).replace(/\n/g, '<br>') +
                (isLongReview ? `... <span class="tmdb-review-toggle">${JE.t('reviews_read_more')}</span>` : '');

            return reviewCard;
        }

        function addReviewsToPage(reviews, contextPage) {
            const existingSection = contextPage.querySelector('.tmdb-reviews-section');
            if (existingSection) {
                existingSection.remove();
            }

            let reviewsSection;
            const hasReviews = reviews && reviews.length > 0;

            if (hasReviews) {
                reviewsSection = document.createElement('details');
                reviewsSection.className = 'detailSection tmdb-reviews-section';
                const summary = document.createElement('summary');
                summary.className = 'sectionTitle';
                summary.innerHTML = `${JE.t('reviews_title', { count: reviews.length })} <i class="material-icons expand-icon">expand_more</i>`;
                reviewsSection.appendChild(summary);

                const swipeContainer = document.createElement('div');
                swipeContainer.className = 'tmdb-review-swipe-container';

                reviews.slice(0, 10).forEach(review => { // Limit to 10 reviews
                    swipeContainer.appendChild(createReviewElement(review));
                });
                reviewsSection.appendChild(swipeContainer);

                swipeContainer.addEventListener('click', function (e) {
                    if (e.target.classList.contains('tmdb-review-toggle')) {
                        const textElement = e.target.parentElement;
                        const card = textElement.closest('.tmdb-review-card');
                        const review = reviews.find(r => escapeHtml(r.author) === card.querySelector('.tmdb-review-author').textContent);

                        if (textElement.classList.toggle('expanded')) {
                            textElement.innerHTML = escapeHtml(review.content).replace(/\n/g, '<br>') + ` <span class="tmdb-review-toggle">${JE.t('reviews_read_less')}</span>`;
                        } else {
                            const previewContent = review.content.substring(0, 350);
                            textElement.innerHTML = escapeHtml(previewContent).replace(/\n/g, '<br>') + `... <span class="tmdb-review-toggle">${JE.t('reviews_read_more')}</span>`;
                        }
                    }
                });
            } else {
                // If no reviews, create a simple, non-expandable header
                reviewsSection = document.createElement('div');
                reviewsSection.className = 'detailSection tmdb-reviews-section';
                const summary = document.createElement('summary');
                summary.className = 'sectionTitle';
                summary.innerHTML = `${JE.t('reviews_title', { count: 0 })}`;
                reviewsSection.appendChild(summary);
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

        function injectCss() {
            const styleId = 'tmdb-reviews-enhanced-styles';
            if (document.getElementById(styleId)) return;

            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .tmdb-reviews-section { margin: 2em 0 1em 0; }
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
                @media (min-width: 768px) { .tmdb-review-card { flex-basis: 400px; } }
                .tmdb-review-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1em; }
                .tmdb-review-author-info { display: flex; flex-direction: column; gap: 0.3em; }
                .tmdb-review-author { color: #fff; font-size: 1.1em; font-weight: 600; }
                .tmdb-review-date { color: #aaa; font-size: 0.9em; }
                .tmdb-review-rating { color: #ffd700; background: rgba(255, 215, 0, 0.1); padding: 0.2em 0.5em; border-radius: 4px; }
                .tmdb-review-content-wrapper { flex-grow: 1; line-height: 1.7; overflow-y: auto; color: #ddd; font-size: 0.95em; }
                .tmdb-review-text { word-wrap: break-word; }
                .tmdb-review-toggle { color: rgb(1, 180, 228); font-weight: bold; cursor: pointer; text-decoration: underline; }
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
                    const item = await ApiClient.getItem(userId, itemId);
                    const tmdbId = item?.ProviderIds?.Tmdb;
                    const mediaType = item?.Type;

                    if (tmdbId && mediaType) {
                        const reviews = await fetchReviews(tmdbId, mediaType);
                        addReviewsToPage(reviews, visiblePage);
                    } else {
                        addReviewsToPage([], visiblePage);
                    }
                }
            } catch (error) {
                console.error(`${logPrefix} Error processing page:`, error);
            }
        }

        function startLoop() {
            setInterval(() => {
                const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
                if (visiblePage) {
                    processPage(visiblePage);
                }
            }, 1000);
        }

        injectCss();
        let mainInterval = setInterval(() => {
            if (typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId()) {
                clearInterval(mainInterval);
                startLoop();
            }
        }, 500);
    };
})(window.JellyfinEnhanced);

