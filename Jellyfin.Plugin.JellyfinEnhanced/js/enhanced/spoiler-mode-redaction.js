/**
 * @file Spoiler Mode Redaction — CSS injection, card redaction/unredaction,
 * reveal controls, and card reveal bindings.
 *
 * Depends on: spoiler-mode.js (core) must load first.
 */
(function (JE) {
    'use strict';

    var core = JE._spoilerCore;
    if (!core) {
        console.warn('🪼 Jellyfin Enhanced: spoiler-mode-redaction.js loaded before core');
        return;
    }

    // ============================================================
    // CSS injection
    // ============================================================

    function injectCSS() {
        if (!JE.helpers?.addCSS) return;

        var BLUR_RADIUS = core.BLUR_RADIUS;
        var SCANNED_ATTR = core.SCANNED_ATTR;
        var DETAIL_OVERVIEW_PENDING_CLASS = core.DETAIL_OVERVIEW_PENDING_CLASS;
        var OVERVIEW_REVEALED_CLASS = core.OVERVIEW_REVEALED_CLASS;

        var css = '\
/* ===== Pre-hide: blur unscanned EPISODE cards to prevent spoiler flash ===== */\n\
body.je-spoiler-active .card[data-type="Episode"]:not([' + SCANNED_ATTR + ']) .cardScalable,\n\
body.je-spoiler-active .listItem[data-id]:not([' + SCANNED_ATTR + ']) .listItem-content {\n\
  overflow: hidden;\n\
}\n\
body.je-spoiler-active .card[data-type="Episode"]:not([' + SCANNED_ATTR + ']) .cardScalable > .cardImageContainer,\n\
body.je-spoiler-active .listItem[data-id]:not([' + SCANNED_ATTR + ']) .listItemImage {\n\
  filter: blur(' + BLUR_RADIUS + ');\n\
  transform: scale(1.05);\n\
}\n\
body.je-spoiler-active .card[data-type="Episode"]:not([' + SCANNED_ATTR + ']) .cardText,\n\
body.je-spoiler-active .card[data-type="Episode"]:not([' + SCANNED_ATTR + ']) .textActionButton,\n\
body.je-spoiler-active .listItem[data-id]:not([' + SCANNED_ATTR + ']) .listItemBodyText:not(.secondary),\n\
body.je-spoiler-active .card[data-type="Episode"]:not([' + SCANNED_ATTR + ']) .cardText-secondary,\n\
body.je-spoiler-active .listItem[data-id]:not([' + SCANNED_ATTR + ']) .listItem-overview,\n\
body.je-spoiler-active .listItem[data-id]:not([' + SCANNED_ATTR + ']) .listItem-bottomoverview,\n\
body.je-spoiler-active .listItem[data-id]:not([' + SCANNED_ATTR + ']) .listItemBody {\n\
  visibility: hidden;\n\
}\n\
\n\
/* ===== Detail page pre-hide: avoid overview flash before async redaction ===== */\n\
body.je-spoiler-active.' + DETAIL_OVERVIEW_PENDING_CLASS + ' #itemDetailPage:not(.hide) .overview,\n\
body.je-spoiler-active.' + DETAIL_OVERVIEW_PENDING_CLASS + ' #itemDetailPage:not(.hide) .itemOverview {\n\
  visibility: hidden;\n\
}\n\
body.je-spoiler-active.' + DETAIL_OVERVIEW_PENDING_CLASS + ' #itemDetailPage:not(.hide) .overview.' + OVERVIEW_REVEALED_CLASS + ',\n\
body.je-spoiler-active.' + DETAIL_OVERVIEW_PENDING_CLASS + ' #itemDetailPage:not(.hide) .itemOverview.' + OVERVIEW_REVEALED_CLASS + ' {\n\
  visibility: visible;\n\
}\n\
\n\
/* ===== Spoiler blur: applied to confirmed-spoiler cards ===== */\n\
.je-spoiler-blur .cardScalable,\n\
.je-spoiler-generic .cardScalable {\n\
  overflow: hidden;\n\
}\n\
\n\
.je-spoiler-blur .cardScalable > .cardImageContainer,\n\
.je-spoiler-blur .cardImage,\n\
.je-spoiler-blur .listItemImage {\n\
  filter: blur(' + BLUR_RADIUS + ');\n\
  transform: scale(1.05);\n\
  transition: filter 0.3s ease;\n\
}\n\
\n\
.je-spoiler-generic .cardScalable > .cardImageContainer,\n\
.je-spoiler-generic .cardImage,\n\
.je-spoiler-generic .listItemImage {\n\
  filter: blur(' + BLUR_RADIUS + ') brightness(0.5) saturate(0.3);\n\
  transform: scale(1.05);\n\
  transition: filter 0.3s ease;\n\
}\n\
\n\
.je-spoiler-blur .cardText-secondary,\n\
.je-spoiler-blur .listItem-overview,\n\
.je-spoiler-blur .listItem-bottomoverview,\n\
.je-spoiler-generic .cardText-secondary,\n\
.je-spoiler-generic .listItem-overview,\n\
.je-spoiler-generic .listItem-bottomoverview {\n\
  visibility: hidden !important;\n\
}\n\
\n\
.je-spoiler-badge {\n\
  position: absolute;\n\
  top: 50%; left: 50%;\n\
  transform: translate(-50%, -50%);\n\
  z-index: 5;\n\
  background: rgba(0,0,0,0.75);\n\
  color: rgba(255,255,255,0.9);\n\
  padding: 4px 10px;\n\
  border-radius: 4px;\n\
  font-size: 11px;\n\
  font-weight: 600;\n\
  letter-spacing: 0.5px;\n\
  text-transform: uppercase;\n\
  pointer-events: none;\n\
  white-space: nowrap;\n\
}\n\
\n\
.je-spoiler-text-redacted {\n\
  color: rgba(255,255,255,0.5) !important;\n\
  font-style: italic !important;\n\
}\n\
\n\
.je-spoiler-metadata-hidden {\n\
  visibility: hidden !important;\n\
}\n\
.je-spoiler-revealing .je-spoiler-metadata-hidden {\n\
  visibility: visible !important;\n\
}\n\
\n\
.je-spoiler-blur .je-spoiler-text-redacted,\n\
.je-spoiler-generic .je-spoiler-text-redacted {\n\
  visibility: visible !important;\n\
  cursor: pointer;\n\
}\n\
\n\
.je-spoiler-overview-hidden {\n\
  color: rgba(255,255,255,0.3) !important;\n\
  font-style: italic !important;\n\
  cursor: pointer;\n\
}\n\
\n\
.je-spoiler-revealing .cardScalable > .cardImageContainer,\n\
.je-spoiler-revealing .cardImage,\n\
.je-spoiler-revealing .listItemImage {\n\
  filter: none !important;\n\
  transform: scale(1) !important;\n\
  transition: filter 0.5s ease, transform 0.5s ease !important;\n\
}\n\
.je-spoiler-revealing .je-spoiler-badge { display: none !important; }\n\
.je-spoiler-revealing .cardText-secondary,\n\
.je-spoiler-revealing .listItem-overview,\n\
.je-spoiler-revealing .listItem-bottomoverview,\n\
.je-spoiler-revealing .listItemBody {\n\
  visibility: visible !important;\n\
}\n\
\n\
.je-spoiler-toggle-btn { transition: background 0.2s ease, opacity 0.2s ease; }\n\
.je-spoiler-toggle-btn.je-spoiler-active { opacity: 1; }\n\
.je-spoiler-toggle-btn.je-spoiler-active .detailButton-icon { color: #ff9800; }\n\
\n\
.je-spoiler-reveal-banner {\n\
  position: fixed; top: 0; left: 0; right: 0; z-index: 99998;\n\
  background: linear-gradient(135deg, rgba(255,152,0,0.9), rgba(255,87,34,0.9));\n\
  color: #fff; padding: 8px 16px; text-align: center;\n\
  font-size: 13px; font-weight: 600;\n\
  display: flex; align-items: center; justify-content: center; gap: 12px;\n\
  backdrop-filter: blur(10px); box-shadow: 0 2px 10px rgba(0,0,0,0.3);\n\
}\n\
.je-spoiler-reveal-banner button {\n\
  background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.3);\n\
  color: #fff; padding: 4px 12px; border-radius: 4px;\n\
  cursor: pointer; font-size: 12px; font-weight: 600;\n\
}\n\
.je-spoiler-reveal-banner button:hover { background: rgba(255,255,255,0.3); }\n\
\n\
.je-spoiler-revealable { cursor: pointer; }\n\
\n\
.je-spoiler-lock-icon {\n\
  display: inline-flex; align-items: center;\n\
  margin-left: 6px; opacity: 0.6; font-size: 14px;\n\
}\n\
\n\
.je-spoiler-osd-redacted {\n\
  color: rgba(255,255,255,0.5) !important;\n\
  font-style: italic !important;\n\
}\n\
\n\
.je-spoiler-confirm-overlay {\n\
  position: fixed; inset: 0; z-index: 100001;\n\
  background: rgba(0,0,0,0.75); backdrop-filter: blur(6px);\n\
  display: flex; align-items: center; justify-content: center;\n\
}\n\
.je-spoiler-confirm-dialog {\n\
  background: linear-gradient(135deg, rgba(30,30,35,0.98), rgba(20,20,25,0.98));\n\
  border: 1px solid rgba(255,255,255,0.12); border-radius: 12px;\n\
  padding: 24px; max-width: 420px; width: 90%; color: #fff;\n\
}\n\
.je-spoiler-confirm-dialog h3 {\n\
  margin: 0 0 12px 0; font-size: 18px; font-weight: 600;\n\
}\n\
.je-spoiler-confirm-dialog p {\n\
  margin: 0 0 20px 0; font-size: 14px;\n\
  color: rgba(255,255,255,0.7); line-height: 1.5;\n\
}\n\
.je-spoiler-confirm-buttons {\n\
  display: flex; flex-direction: column; gap: 8px;\n\
}\n\
.je-spoiler-confirm-btn {\n\
  border: none; color: #fff; padding: 10px 16px;\n\
  border-radius: 6px; cursor: pointer; font-size: 14px;\n\
  font-weight: 500; transition: background 0.2s ease; text-align: center;\n\
}\n\
.je-spoiler-confirm-reveal {\n\
  background: rgba(255,152,0,0.6); border: 1px solid rgba(255,152,0,0.7);\n\
}\n\
.je-spoiler-confirm-reveal:hover { background: rgba(255,152,0,0.8); }\n\
.je-spoiler-confirm-disable {\n\
  background: rgba(220,50,50,0.5); border: 1px solid rgba(220,50,50,0.6);\n\
}\n\
.je-spoiler-confirm-disable:hover { background: rgba(220,50,50,0.7); }\n\
.je-spoiler-confirm-cancel {\n\
  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15);\n\
}\n\
.je-spoiler-confirm-cancel:hover { background: rgba(255,255,255,0.2); }\n\
\n\
/* Episode detail page protection */\n\
.je-spoiler-episode-protected .detailImageContainer img,\n\
.je-spoiler-episode-protected .detailImageContainer .cardImageContainer {\n\
  filter: blur(' + BLUR_RADIUS + ') !important;\n\
  transition: filter 0.3s ease !important;\n\
  cursor: pointer;\n\
}\n\
.je-spoiler-episode-protected .detailImageContainer .je-spoiler-poster-revealed,\n\
.je-spoiler-episode-protected .detailImageContainer img.je-spoiler-poster-revealed {\n\
  filter: none !important;\n\
}\n\
.je-spoiler-poster-overlay {\n\
  position: absolute;\n\
  top: 0; left: 0; right: 0; bottom: 0;\n\
  display: flex;\n\
  align-items: center;\n\
  justify-content: center;\n\
  color: rgba(255,255,255,0.7);\n\
  font-size: 0.85em;\n\
  font-style: italic;\n\
  text-align: center;\n\
  z-index: 1;\n\
  pointer-events: none;\n\
}\n\
.je-spoiler-episode-protected .mediaInfoContent,\n\
.je-spoiler-episode-protected .itemGenres,\n\
.je-spoiler-episode-protected .itemExternalLinks,\n\
.je-spoiler-episode-protected .itemDirectors,\n\
.je-spoiler-episode-protected .itemWriters,\n\
.je-spoiler-episode-protected .itemMiscInfo {\n\
  visibility: hidden !important;\n\
}';

        JE.helpers.addCSS('je-spoiler-mode', css);
    }

    // ============================================================
    // Card redaction
    // ============================================================

    function redactCard(card, itemData) {
        if (core.revealAllActive) return;
        if (card.hasAttribute(core.REDACTED_ATTR)) return;
        var cardBox0 = card.querySelector('.cardBox') || card;
        if (cardBox0.classList.contains('je-spoiler-revealing')) return;

        var settings = core.getSettings();
        var artworkPolicy = settings.artworkPolicy || 'blur';

        var cardBox = card.querySelector('.cardBox') || card;
        if (artworkPolicy === 'blur') {
            cardBox.classList.add('je-spoiler-blur');
            cardBox.classList.remove('je-spoiler-generic');
        } else {
            cardBox.classList.add('je-spoiler-generic');
            cardBox.classList.remove('je-spoiler-blur');
        }

        var imageContainer = card.querySelector('.cardImageContainer') || card.querySelector('.cardImage') || card.querySelector('.listItemImage');
        if (imageContainer && !imageContainer.querySelector('.je-spoiler-badge')) {
            var badge = document.createElement('div');
            badge.className = 'je-spoiler-badge';
            badge.textContent = core.tFallback('spoiler_mode_hidden_badge', 'SPOILER');
            imageContainer.appendChild(badge);
        }

        var titleElements = card.querySelectorAll('.cardText, .listItemBodyText');
        var hasSecondaryText = !!card.querySelector('.cardText-secondary');
        var redactedTitle = core.formatRedactedTitle(
            itemData.ParentIndexNumber,
            itemData.IndexNumber,
            itemData.IndexNumberEnd,
            itemData.ParentIndexNumber === 0
        );
        var isFirstRedactable = true;
        for (var titleEl of titleElements) {
            if (titleEl.classList.contains('je-spoiler-text-redacted')) continue;
            if (titleEl.classList.contains('je-spoiler-metadata-hidden')) continue;

            if (hasSecondaryText && titleEl.classList.contains('cardText-first')) continue;

            if (isFirstRedactable) {
                if (!titleEl.dataset.jeSpoilerOriginal) {
                    titleEl.dataset.jeSpoilerOriginal = titleEl.textContent;
                }
                titleEl.dataset.jeSpoilerRedacted = redactedTitle;
                titleEl.textContent = redactedTitle;
                titleEl.classList.add('je-spoiler-text-redacted', 'je-spoiler-revealable');
                isFirstRedactable = false;
            } else {
                titleEl.classList.add('je-spoiler-metadata-hidden');
            }
        }

        bindCardReveal(card);
        card.setAttribute(core.REDACTED_ATTR, '1');
    }

    function blurCardArtwork(card) {
        if (card.hasAttribute(core.REDACTED_ATTR)) return;

        var settings = core.getSettings();
        var artworkPolicy = settings.artworkPolicy || 'blur';
        var cardBox = card.querySelector('.cardBox') || card;

        if (artworkPolicy === 'blur') {
            cardBox.classList.add('je-spoiler-blur');
            cardBox.classList.remove('je-spoiler-generic');
        } else {
            cardBox.classList.add('je-spoiler-generic');
            cardBox.classList.remove('je-spoiler-blur');
        }

        var imageContainer = card.querySelector('.cardImageContainer') || card.querySelector('.cardImage');
        if (imageContainer && !imageContainer.querySelector('.je-spoiler-badge')) {
            var badge = document.createElement('div');
            badge.className = 'je-spoiler-badge';
            badge.textContent = core.tFallback('spoiler_mode_hidden_badge', 'SPOILER');
            imageContainer.appendChild(badge);
        }

        card.setAttribute(core.REDACTED_ATTR, '1');
    }

    function redactChapterCard(card, chapterIndex) {
        if (card.hasAttribute(core.REDACTED_ATTR)) return;

        blurCardArtwork(card);

        var titleEl = card.querySelector('.cardText');
        if (titleEl && !titleEl.dataset.jeSpoilerOriginal) {
            var original = titleEl.textContent;
            if (original && original.trim()) {
                titleEl.dataset.jeSpoilerOriginal = original;
                titleEl.dataset.jeSpoilerRedacted = '1';
                titleEl.textContent = 'Chapter ' + chapterIndex;
                titleEl.classList.add('je-spoiler-text-redacted');
            }
        }

        bindCardReveal(card);
    }

    function unredactCard(card) {
        var cardBox = card.querySelector('.cardBox') || card;
        cardBox.classList.remove('je-spoiler-blur', 'je-spoiler-generic', 'je-spoiler-revealing');

        card.querySelectorAll('.je-spoiler-badge').forEach(function (b) { b.remove(); });

        card.querySelectorAll('.je-spoiler-text-redacted, [data-je-spoiler-original]').forEach(function (el) {
            if (el.dataset.jeSpoilerOriginal) {
                el.textContent = el.dataset.jeSpoilerOriginal;
                delete el.dataset.jeSpoilerOriginal;
                delete el.dataset.jeSpoilerRedacted;
            }
            el.classList.remove('je-spoiler-text-redacted', 'je-spoiler-revealable');
        });

        card.querySelectorAll('.je-spoiler-metadata-hidden, .je-spoiler-metadata-revealed').forEach(function (el) {
            el.classList.remove('je-spoiler-metadata-hidden', 'je-spoiler-metadata-revealed');
        });

        card.removeAttribute(core.REDACTED_ATTR);
    }

    /**
     * Clears all spoiler redaction artifacts from the current DOM.
     * Optimized: uses a single compound selector instead of 15+ separate queries.
     */
    function clearAllRedactions() {
        core.revealAllActive = false;
        core.setDetailOverviewPending(false);
        if (core.revealAllTimer) {
            clearTimeout(core.revealAllTimer);
            core.revealAllTimer = null;
        }
        if (core.revealAllCountdownInterval) {
            clearInterval(core.revealAllCountdownInterval);
            core.revealAllCountdownInterval = null;
        }
        document.querySelector('.je-spoiler-reveal-banner')?.remove();

        // Single compound query for all spoiler-related elements
        var allEls = document.querySelectorAll(
            '[' + core.REDACTED_ATTR + '], ' +
            '[' + core.PROCESSED_ATTR + '], ' +
            '[' + core.SCANNED_ATTR + '], ' +
            '[data-je-spoiler-original], ' +
            '[data-je-spoiler-reveal-bound], ' +
            '[data-je-spoiler-overview-safe-for], ' +
            '.je-spoiler-blur, .je-spoiler-generic, .je-spoiler-revealing, ' +
            '.je-spoiler-text-redacted, .je-spoiler-revealable, ' +
            '.je-spoiler-metadata-hidden, .je-spoiler-metadata-revealed, ' +
            '.je-spoiler-overview-hidden, .' + core.OVERVIEW_REVEALED_CLASS + ', ' +
            '.je-spoiler-osd-redacted, .je-spoiler-badge, ' +
            '.je-spoiler-toggle-btn, .je-spoiler-reveal-all-btn, ' +
            '.je-spoiler-episode-protected'
        );

        for (var i = 0; i < allEls.length; i++) {
            var el = allEls[i];

            // Remove badges (detach from DOM)
            if (el.classList.contains('je-spoiler-badge')) {
                el.remove();
                continue;
            }

            // Remove toggle/reveal buttons (detach from DOM)
            if (el.classList.contains('je-spoiler-toggle-btn') || el.classList.contains('je-spoiler-reveal-all-btn')) {
                el.remove();
                continue;
            }

            // Restore original text from data attributes
            if (el.dataset.jeSpoilerOriginal) {
                el.textContent = el.dataset.jeSpoilerOriginal;
                delete el.dataset.jeSpoilerOriginal;
                delete el.dataset.jeSpoilerRedacted;
            }

            // Clean up data attributes
            if (el.hasAttribute(core.REDACTED_ATTR)) el.removeAttribute(core.REDACTED_ATTR);
            if (el.hasAttribute(core.PROCESSED_ATTR)) el.removeAttribute(core.PROCESSED_ATTR);
            if (el.hasAttribute(core.SCANNED_ATTR)) el.removeAttribute(core.SCANNED_ATTR);
            if (el.dataset.jeSpoilerRevealUntil) delete el.dataset.jeSpoilerRevealUntil;
            if (el.dataset.jeSpoilerOverviewSafeFor) delete el.dataset.jeSpoilerOverviewSafeFor;
            if (el.dataset.jeSpoilerOverviewBound) delete el.dataset.jeSpoilerOverviewBound;
            if (el.dataset.jeSpoilerRevealBound) delete el.dataset.jeSpoilerRevealBound;

            // Remove all spoiler CSS classes
            el.classList.remove(
                'je-spoiler-blur', 'je-spoiler-generic', 'je-spoiler-revealing',
                'je-spoiler-text-redacted', 'je-spoiler-revealable',
                'je-spoiler-metadata-hidden', 'je-spoiler-metadata-revealed',
                'je-spoiler-overview-hidden', core.OVERVIEW_REVEALED_CLASS,
                'je-spoiler-osd-redacted', 'je-spoiler-episode-protected'
            );

            // Clear inline blur styles on backdrop/images
            if ((el.style?.filter || '').indexOf('blur') !== -1) {
                el.style.filter = '';
                el.style.transition = '';
            }
        }

        // Separate pass for backdrop images (may not have spoiler classes/attributes)
        document.querySelectorAll('.backdropImage, .detailImageContainer img').forEach(function (el) {
            if (el.style.filter && el.style.filter.indexOf('blur') !== -1) {
                el.style.filter = '';
                el.style.transition = '';
            }
        });
    }

    // ============================================================
    // Reveal controls
    // ============================================================

    function revealCard(card) {
        var cardBox = card.querySelector('.cardBox') || card;
        cardBox.classList.add('je-spoiler-revealing');

        card.querySelectorAll('.je-spoiler-text-redacted').forEach(function (el) {
            if (el.dataset.jeSpoilerOriginal) {
                el.textContent = el.dataset.jeSpoilerOriginal;
                el.classList.remove('je-spoiler-text-redacted');
            }
        });

        card.querySelectorAll('.je-spoiler-metadata-hidden').forEach(function (el) {
            el.classList.remove('je-spoiler-metadata-hidden');
            el.classList.add('je-spoiler-metadata-revealed');
        });
    }

    function hideCard(card) {
        var cardBox = card.querySelector('.cardBox') || card;
        cardBox.classList.remove('je-spoiler-revealing');

        card.querySelectorAll('[data-je-spoiler-redacted]').forEach(function (el) {
            el.textContent = el.dataset.jeSpoilerRedacted;
            el.classList.add('je-spoiler-text-redacted');
        });

        card.querySelectorAll('.je-spoiler-metadata-revealed').forEach(function (el) {
            el.classList.remove('je-spoiler-metadata-revealed');
            el.classList.add('je-spoiler-metadata-hidden');
        });
    }

    function bindCardReveal(card) {
        if (card.dataset.jeSpoilerRevealBound) return;
        card.dataset.jeSpoilerRevealBound = '1';

        var cardBox = card.querySelector('.cardBox') || card;
        var revealed = false;
        var longPressTimer = null;

        function doReveal() {
            if (core.revealAllActive || revealed) return;
            revealed = true;
            revealCard(card);
        }

        function doHide() {
            if (!revealed) return;
            revealed = false;
            hideCard(card);
        }

        card.addEventListener('click', function (e) {
            var target = e.target;
            if (target.closest('.je-spoiler-revealable') || target.closest('.je-spoiler-text-redacted')) {
                e.preventDefault();
                e.stopPropagation();
                doReveal();
            }
        });

        cardBox.addEventListener('mouseleave', function () {
            if (revealed) doHide();
        });

        card.addEventListener('touchstart', function () {
            if (revealed) return;
            longPressTimer = setTimeout(function () {
                longPressTimer = null;
                doReveal();
            }, core.LONG_PRESS_THRESHOLD_MS);
        }, { passive: true });

        card.addEventListener('touchend', function () {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            if (revealed) doHide();
        }, { passive: true });

        card.addEventListener('touchcancel', function () {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            if (revealed) doHide();
        }, { passive: true });
    }

    function activateRevealAll() {
        core.revealAllActive = true;

        document.querySelector('.je-spoiler-reveal-banner')?.remove();

        var banner = document.createElement('div');
        banner.className = 'je-spoiler-reveal-banner';

        var duration = core.REVEAL_ALL_DURATION;
        var remaining = Math.ceil(duration / 1000);

        var text = document.createElement('span');
        text.textContent = 'Spoilers revealed \u2014 ' + remaining + 's remaining';
        banner.appendChild(text);

        var hideBtn = document.createElement('button');
        hideBtn.textContent = 'Hide Now';
        hideBtn.addEventListener('click', function () { deactivateRevealAll(); });
        banner.appendChild(hideBtn);

        document.body.appendChild(banner);

        if (core.revealAllCountdownInterval) clearInterval(core.revealAllCountdownInterval);
        core.revealAllCountdownInterval = setInterval(function () {
            remaining--;
            if (remaining <= 0) {
                clearInterval(core.revealAllCountdownInterval);
                core.revealAllCountdownInterval = null;
                return;
            }
            text.textContent = 'Spoilers revealed \u2014 ' + remaining + 's remaining';
        }, 1000);

        document.querySelectorAll('.je-spoiler-blur, .je-spoiler-generic').forEach(function (el) {
            el.classList.add('je-spoiler-revealing');
        });

        document.querySelectorAll('.je-spoiler-text-redacted').forEach(function (el) {
            if (el.dataset.jeSpoilerOriginal) {
                el.textContent = el.dataset.jeSpoilerOriginal;
                el.classList.remove('je-spoiler-text-redacted');
            }
        });

        document.querySelectorAll('.je-spoiler-metadata-hidden').forEach(function (el) {
            el.classList.remove('je-spoiler-metadata-hidden');
            el.classList.add('je-spoiler-metadata-revealed');
        });

        document.querySelectorAll('.je-spoiler-overview-hidden').forEach(function (el) {
            if (el.dataset.jeSpoilerOriginal) {
                el.textContent = el.dataset.jeSpoilerOriginal;
                el.classList.remove('je-spoiler-overview-hidden');
            }
        });

        // Remove episode detail page protection
        document.querySelectorAll('.je-spoiler-episode-protected').forEach(function (el) {
            el.classList.remove('je-spoiler-episode-protected');
        });

        // Clear backdrop and poster blurs
        document.querySelectorAll('.backdropImage, .detailImageContainer img, .detailImageContainer .cardImageContainer').forEach(function (el) {
            if (el.style.filter && el.style.filter.indexOf('blur') !== -1) {
                el.style.filter = '';
                el.style.transition = '';
            }
        });

        if (core.revealAllTimer) clearTimeout(core.revealAllTimer);
        core.revealAllTimer = setTimeout(function () {
            clearInterval(core.revealAllCountdownInterval);
            core.revealAllCountdownInterval = null;
            deactivateRevealAll();
        }, duration);
    }

    function deactivateRevealAll() {
        core.revealAllActive = false;

        document.querySelector('.je-spoiler-reveal-banner')?.remove();

        if (core.revealAllTimer) {
            clearTimeout(core.revealAllTimer);
            core.revealAllTimer = null;
        }
        if (core.revealAllCountdownInterval) {
            clearInterval(core.revealAllCountdownInterval);
            core.revealAllCountdownInterval = null;
        }

        document.querySelectorAll('.je-spoiler-revealing').forEach(function (el) {
            el.classList.remove('je-spoiler-revealing');
        });

        if (core.processCurrentPage) core.processCurrentPage();
    }

    // ============================================================
    // Register on core
    // ============================================================

    core.injectCSS = injectCSS;
    core.redactCard = redactCard;
    core.blurCardArtwork = blurCardArtwork;
    core.redactChapterCard = redactChapterCard;
    core.unredactCard = unredactCard;
    core.clearAllRedactions = clearAllRedactions;
    core.activateRevealAll = activateRevealAll;
    core.deactivateRevealAll = deactivateRevealAll;
    core.revealCard = revealCard;
    core.hideCard = hideCard;
    core.bindCardReveal = bindCardReveal;

})(window.JellyfinEnhanced);
