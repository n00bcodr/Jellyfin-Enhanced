/**
 * @file Manages video playback controls and enhancements.
 */
(function(JE) {
    'use strict';

    /**
     * Finds the currently active video element on the page.
     * @returns {HTMLVideoElement|null} The video element or null if not found.
     */
    const getVideo = () => document.querySelector('video');

    /**
     * Finds the main settings button in the video player OSD.
     * @returns {HTMLElement|null} The settings button element.
     */
    const settingsBtn = () => document.querySelector(
    '.videoOsdBottom .btnVideoOsdSettings, .videoOsdBottom button[title="Settings"], .videoOsdBottom button[aria-label="Settings"]'
    );

    JE.openSettings = (cb) => {
        settingsBtn()?.click();
        setTimeout(cb, 120); // Wait for the menu to animate open
    };

    /**
     * Adjusts playback speed up or down through a predefined list of speeds.
     * @param {string} direction Either 'increase' or 'decrease'.
     */
    JE.adjustPlaybackSpeed = (direction) => {
        const video = getVideo();
        if (!video) {
            JE.toast(JE.t('toast_no_video_found'));
            return;
        }
        const speeds = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
        let currentIndex = speeds.findIndex(speed => Math.abs(speed - video.playbackRate) < 0.01);
        if (currentIndex === -1) {
            currentIndex = speeds.findIndex(speed => speed >= video.playbackRate);
            if (currentIndex === -1) currentIndex = speeds.length - 1;
        }
        if (direction === 'increase') {
            currentIndex = Math.min(currentIndex + 1, speeds.length - 1);
        } else {
            currentIndex = Math.max(currentIndex - 1, 0);
        }
        video.playbackRate = speeds[currentIndex];
        JE.toast(JE.t('toast_speed', { speed: speeds[currentIndex] }));
    };

    /**
     * Resets the video playback speed to normal (1.0x).
     */
    JE.resetPlaybackSpeed = () => {
        const video = getVideo();
        if (!video) {
            JE.toast(JE.t('toast_no_video_found'));
            return;
        }
        video.playbackRate = 1.0;
        JE.toast(JE.t('toast_speed_normal'));
    };

    /**
     * Jumps to a specific percentage of the video's duration.
     * @param {number} percentage The percentage to jump to (0-100).
     */
    JE.jumpToPercentage = (percentage) => {
        const video = getVideo();
        if (!video || !video.duration) {
            JE.toast(JE.t('toast_no_video_found'));
            return;
        }
        video.currentTime = video.duration * (percentage / 100);
        JE.toast(JE.t('toast_jumped_to', { percent: percentage }));
    };

    // Frame Step (YouTube-style , / .). FPS cached per (itemId + media source) so series
    // auto-play swaps don't cross-pollute. Transient failures fall back to 24 without caching.
    const FRAME_STEP_FALLBACK_FPS = 24;
    const _fpsCache = new Map();
    const _fpsInflight = new Map();
    let _frameOverlay = null;
    let _frameOverlayHideTimer = null;
    let _frameOverlayFadeTimer = null;
    const _fallbackFpsWarned = new Set();

    function getCurrentVideoItemId() {
        try {
            const hash = window.location.hash || '';
            const q = hash.indexOf('?');
            if (q === -1) return null;
            return new URLSearchParams(hash.substring(q + 1)).get('id');
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: frame-step item id parse failed', err);
            return null;
        }
    }

    function pickFps(stream) {
        if (!stream) return null;
        const candidates = [stream.ReferenceFrameRate, stream.RealFrameRate, stream.AverageFrameRate];
        for (const c of candidates) {
            const n = parseFloat(c);
            if (Number.isFinite(n) && n >= 1 && n < 1000) return n;
        }
        return null;
    }

    function getActiveMediaSourceId(video) {
        try {
            const src = video?.currentSrc || video?.src || '';
            const q = src.indexOf('?');
            if (q === -1) return null;
            return new URLSearchParams(src.substring(q + 1)).get('MediaSourceId') || null;
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: frame-step MediaSourceId parse failed', err);
            return null;
        }
    }

    async function fetchFpsForItem(itemId, activeMediaSourceId) {
        if (!itemId || !window.ApiClient) return null;
        try {
            const userId = window.ApiClient.getCurrentUserId();
            const item = await window.ApiClient.getItem(userId, itemId);
            const sources = Array.isArray(item?.MediaSources) ? item.MediaSources : [];
            const ordered = activeMediaSourceId
                ? [...sources.filter(s => s.Id === activeMediaSourceId), ...sources.filter(s => s.Id !== activeMediaSourceId)]
                : sources;
            for (const source of ordered) {
                const vs = source.MediaStreams?.find(s => s.Type === 'Video');
                const fps = pickFps(vs);
                if (fps) return fps;
            }
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: frame-step fps lookup failed', err);
        }
        return null;
    }

    function getFpsCacheKey(itemId, video) {
        if (!itemId) return null;
        const msId = getActiveMediaSourceId(video);
        if (msId) return `${itemId}|ms:${msId}`;
        const src = (video?.currentSrc || video?.src || '').split('?')[0];
        return `${itemId}|src:${src}`;
    }

    async function resolveFps(video) {
        const itemId = getCurrentVideoItemId();
        const cacheKey = getFpsCacheKey(itemId, video);
        if (cacheKey && _fpsCache.has(cacheKey)) return _fpsCache.get(cacheKey);
        // Inflight keyed by itemId so presses before/after currentSrc populates share one fetch.
        if (itemId && _fpsInflight.has(itemId)) return _fpsInflight.get(itemId);

        const activeMediaSourceId = getActiveMediaSourceId(video);
        const promise = (async () => {
            const fetched = itemId ? await fetchFpsForItem(itemId, activeMediaSourceId) : null;
            const isReal = Number.isFinite(fetched) && fetched >= 1;
            const fps = isReal ? fetched : FRAME_STEP_FALLBACK_FPS;
            // Build write key from the source we fetched for, not getVideo() which may have swapped.
            const finalKey = itemId
                ? (activeMediaSourceId
                    ? `${itemId}|ms:${activeMediaSourceId}`
                    : `${itemId}|src:${(video?.currentSrc || video?.src || '').split('?')[0]}`)
                : null;
            if (finalKey && isReal) _fpsCache.set(finalKey, fps);
            if (!isReal && itemId && !_fallbackFpsWarned.has(itemId)) {
                try {
                    JE.toast(tWithFallback(
                        'toast_frame_step_fps_fallback',
                        'ℹ Frame step using fallback {fps} fps (actual rate unknown)',
                        { fps: FRAME_STEP_FALLBACK_FPS }
                    ));
                    _fallbackFpsWarned.add(itemId);
                } catch (err) {
                    console.warn('🪼 Jellyfin Enhanced: frame-step fallback toast failed', err);
                }
            }
            return fps;
        })();
        if (itemId) _fpsInflight.set(itemId, promise);
        try { return await promise; }
        finally { if (itemId) _fpsInflight.delete(itemId); }
    }

    // JE.t returns the raw key on miss; tWithFallback substitutes an inline English default
    // until upstream en.json catches up. Mirrors elsewhere/reviews.js.
    const _tFallbackWarned = new Set();
    function tWithFallback(key, fallback, params) {
        let result;
        try {
            result = JE.t(key, params);
        } catch (err) {
            console.warn(`🪼 Jellyfin Enhanced: JE.t('${key}') threw, using fallback:`, err);
            result = null;
        }
        if (!result || result === key) {
            if (!_tFallbackWarned.has(key)) {
                _tFallbackWarned.add(key);
                console.warn(`🪼 Jellyfin Enhanced: missing translation key '${key}', using inline fallback`);
            }
            let out = fallback;
            if (params) {
                for (const [k, v] of Object.entries(params)) {
                    out = out.split(`{${k}}`).join(String(v));
                }
            }
            return out;
        }
        return result;
    }

    function showFrameOverlay(text) {
        if (!_frameOverlay) {
            _frameOverlay = document.createElement('div');
            _frameOverlay.setAttribute('data-je-frame-overlay', 'true');
            _frameOverlay.style.cssText = `
                position: fixed; bottom: 18%; left: 50%; transform: translateX(-50%);
                background: rgba(0,0,0,0.78); color: #fff; padding: 6px 14px; border-radius: 6px;
                font-size: 0.95em; font-weight: 600; z-index: 999999;
                pointer-events: none; font-family: system-ui;
                opacity: 0; transition: opacity 0.15s ease-out; display: none;
                white-space: nowrap;
            `;
            document.body.appendChild(_frameOverlay);
        }
        _frameOverlay.textContent = text;
        _frameOverlay.style.display = 'block';
        requestAnimationFrame(() => {
            if (_frameOverlay) _frameOverlay.style.opacity = '1';
        });

        if (_frameOverlayHideTimer) { clearTimeout(_frameOverlayHideTimer); _frameOverlayHideTimer = null; }
        if (_frameOverlayFadeTimer) { clearTimeout(_frameOverlayFadeTimer); _frameOverlayFadeTimer = null; }
        _frameOverlayHideTimer = setTimeout(() => {
            _frameOverlayHideTimer = null;
            if (!_frameOverlay) return;
            _frameOverlay.style.opacity = '0';
            _frameOverlayFadeTimer = setTimeout(() => {
                _frameOverlayFadeTimer = null;
                if (_frameOverlay && _frameOverlay.style.opacity === '0') {
                    _frameOverlay.style.display = 'none';
                }
            }, 200);
        }, 900);
    }

    JE.frameStep = async (direction) => {
      try {
        const video = getVideo();
        if (!video) {
            JE.toast(JE.t('toast_no_video_found'));
            return;
        }
        if (!video.paused) {
            try {
                const r = video.pause();
                // pause() returns a Promise on Chromecast/MSE/PiP; swallow rejection.
                if (r && typeof r.catch === 'function') {
                    r.catch(err => console.warn('🪼 Jellyfin Enhanced: video.pause() rejected', err));
                }
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: video.pause() threw', err);
            }
        }

        const fps = await resolveFps(video);
        const frameDuration = 1 / fps;
        const delta = direction === 'forward' ? frameDuration : -frameDuration;
        const upper = Number.isFinite(video.duration) ? video.duration : Infinity;
        const newTime = Math.max(0, Math.min(upper, video.currentTime + delta));
        video.currentTime = newTime;

        const arrow = direction === 'forward' ? '▶' : '◀';
        const frameNum = Math.max(0, Math.round(newTime * fps));
        const fpsLabel = Number.isInteger(fps) ? String(fps) : fps.toFixed(3).replace(/\.?0+$/, '');
        const text = tWithFallback(
            'toast_frame_step',
            '{arrow} Frame {frame}  ·  {fps} fps',
            { arrow, frame: frameNum, fps: fpsLabel }
        );
        showFrameOverlay(text);
      } catch (err) {
        console.warn('🪼 Jellyfin Enhanced: frameStep failed', err);
      }
    };

    // --- Jump Back  ---
    // Track the last "stable" playback position via timeupdate (fires ~4x/sec
    // while playing). When a seek starts we snapshot that stable value — not
    // video.currentTime inside the seeking event
    // A guard flag prevents the jump-back action itself from overwriting the saved position.
    let _lastStablePosition = null;   // updated continuously during normal playback
    let _lastPositionBeforeSeek = null; // snapshotted at seek start
    let _jumpingBack = false;

    /**
     * Attaches timeupdate + seeking listeners to the given video element to track
     * the last known position before each seek. Safe to call multiple times — the
     * listeners are stored on the element and only attached once.
     * @param {HTMLVideoElement} video
     */
    JE.attachSeekTracker = (video) => {
        if (!video || video._jeSeekTrackerAttached) return;

        // Keep a rolling record of where we actually are during normal playback
        video.addEventListener('timeupdate', () => {
            if (_jumpingBack) return;
            if (!video.seeking && Number.isFinite(video.currentTime) && video.currentTime > 0) {
                _lastStablePosition = video.currentTime;
            }
        });

        video.addEventListener('seeking', () => {
            if (_jumpingBack) return;
            if (_lastStablePosition !== null) {
                _lastPositionBeforeSeek = _lastStablePosition;
            }
        });

        video._jeSeekTrackerAttached = true;
    };

    /**
     * Jumps back to the position captured just before the last seek.
     */
    JE.jumpToLastPosition = () => {
        const video = getVideo();
        if (!video) {
            JE.toast(JE.t('toast_no_video_found'));
            return;
        }
        if (_lastPositionBeforeSeek === null) {
            JE.toast(tWithFallback('toast_no_last_position', '{{icon:rewind}} No previous position saved'));
            return;
        }
        const targetTime = _lastPositionBeforeSeek;
        _lastPositionBeforeSeek = null; // consume it so repeated presses don't loop
        _jumpingBack = true;
        _lastStablePosition = null;    // reset so it re-accumulates after the jump
        video.currentTime = targetTime;
        setTimeout(() => { _jumpingBack = false; }, 500);

        const mins = Math.floor(targetTime / 60);
        const secs = Math.floor(targetTime % 60).toString().padStart(2, '0');
        JE.toast(tWithFallback('toast_jumped_back', '{{icon:rewind}} Jumped back to {time}', { time: `${mins}:${secs}` }));
    };

    /**
     * Manually triggers the skip intro/outro button if it's visible.
     */
    JE.skipIntroOutro = () => {
        const skipButton = document.querySelector('button.skip-button.emby-button:not(.skip-button-hidden):not(.hide)');
        if (skipButton) {
            const buttonText = skipButton.textContent || '';
            skipButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            skipButton.click();

            if (buttonText.includes('Skip Intro')) {
                JE.toast(JE.t('toast_skipped_intro'));
            } else if (buttonText.includes('Skip Outro')) {
                JE.toast(JE.t('toast_skipped_outro'));
            } else {
                JE.toast('⏭️ Skipped');
            }
        } else {
            JE.toast(JE.t('toast_no_skip_button'));
        }
    };

    /**
     * Cycles through available subtitle tracks in the OSD menu.
     */
    JE.cycleSubtitleTrack = () => {
        const performCycle = () => {
            const allItems = document.querySelectorAll('.actionSheetContent .listItem');
            if (allItems.length === 0) {
                JE.toast(JE.t('toast_no_subtitles_found'));
                document.body.click();
                return;
            }

            const subtitleOptions = Array.from(allItems).filter(item => {
                const textElement = item.querySelector('.listItemBodyText');
                return textElement && textElement.textContent.trim() !== 'Secondary Subtitles';
            });

            if (subtitleOptions.length === 0) {
                JE.toast(JE.t('toast_no_subtitles_found'));
                document.body.click();
                return;
            }

            let currentIndex = subtitleOptions.findIndex(option => {
                const checkIcon = option.querySelector('.listItemIcon.check');
                return checkIcon && getComputedStyle(checkIcon).visibility !== 'hidden';
            });

            const nextIndex = (currentIndex + 1) % subtitleOptions.length;
            const nextOption = subtitleOptions[nextIndex];

            if (nextOption) {
                nextOption.click();
                const subtitleName = nextOption.querySelector('.listItemBodyText').textContent.trim();
                JE.toast(JE.t('toast_subtitle', { subtitle: subtitleName }));
            }
        };

        const subtitleMenuTitle = Array.from(document.querySelectorAll('.actionSheetContent .actionSheetTitle')).find(el => el.textContent === 'Subtitles');
        if (subtitleMenuTitle) {
            performCycle();
        } else {
            if (document.querySelector('.actionSheetContent')) {
                document.body.click();
            }
            document.querySelector('button.btnSubtitles')?.click();
            setTimeout(performCycle, 200);
        }
    };

    /**
     * Cycles through available audio tracks in the OSD menu.
     */
    JE.cycleAudioTrack = () => {
        const performCycle = () => {
            const audioOptions = Array.from(document.querySelectorAll('.actionSheetContent .listItem')).filter(item => item.querySelector('.listItemBodyText.actionSheetItemText'));

            if (audioOptions.length === 0) {
                JE.toast(JE.t('toast_no_audio_tracks_found'));
                document.body.click();
                return;
            }

            let currentIndex = audioOptions.findIndex(option => {
                const checkIcon = option.querySelector('.actionsheetMenuItemIcon.listItemIcon.check');
                return checkIcon && getComputedStyle(checkIcon).visibility !== 'hidden';
            });

            const nextIndex = (currentIndex + 1) % audioOptions.length;
            const nextOption = audioOptions[nextIndex];

            if (nextOption) {
                nextOption.click();
                const audioName = nextOption.querySelector('.listItemBodyText.actionSheetItemText').textContent.trim();
                JE.toast(JE.t('toast_audio', { audio: audioName }));
            }
        };

        const audioMenuTitle = Array.from(document.querySelectorAll('.actionSheetContent .actionSheetTitle')).find(el => el.textContent === 'Audio');
        if (audioMenuTitle) {
            performCycle();
        } else {
            if (document.querySelector('.actionSheetContent')) {
                document.body.click();
            }
            document.querySelector('button.btnAudio')?.click();
            setTimeout(performCycle, 200);
        }
    };

    /**
     * Cycles through video aspect ratio modes (Auto, Cover, Fill).
     */
    const performAspectCycle = () => {
        const opts = [...document.querySelectorAll('.actionSheetContent button[data-id="auto"], .actionSheetContent button[data-id="cover"], .actionSheetContent button[data-id="fill"]')];

        if (!opts.length) {
            document.querySelector('.actionSheetContent button[data-id="aspectratio"]')?.click();
            setTimeout(performAspectCycle, 120);
            return;
        }

        // If options are found, cycle them.
        const current = opts.findIndex(b => b.querySelector('.check')?.style.visibility !== 'hidden');
        const next = opts[(current + 1) % opts.length];
        if (next) {
            next.click();
            JE.toast(JE.t('toast_aspect_ratio', { ratio: next.textContent.trim() }));
        }
    };

    // The main function called by the shortcut to start the process.
    JE.cycleAspect = () => {
        // This opens the main settings panel ONCE and then hands off to the inner logic.
        JE.openSettings(performAspectCycle);
    };

    let skipButtonObserver = null;

    /**
     * Initializes a MutationObserver to watch for the skip button's appearance.
     */
    JE.initializeAutoSkipObserver = () => {
        if (skipButtonObserver) {
            return; // Observer is already running
        }
        skipButtonObserver = new MutationObserver((mutationsList) => {
            for (const mutation of mutationsList) {
                if (mutation.type === 'childList' || mutation.type === 'attributes') {
                    const skipButton = document.querySelector('button.skip-button.emby-button:not(.skip-button-hidden):not(.hide)');
                    if (skipButton && !JE.state.skipToastShown) {
                        const buttonText = skipButton.textContent || '';
                        if (JE.currentSettings.autoSkipIntro && buttonText.includes('Skip Intro')) {
                            skipButton.click();
                            JE.toast(JE.t('toast_auto_skipped_intro'));
                            JE.state.skipToastShown = true;
                        } else if (JE.currentSettings.autoSkipOutro && buttonText.includes('Skip Outro')) {
                            skipButton.click();
                            JE.toast(JE.t('toast_auto_skipped_outro'));
                            JE.state.skipToastShown = true;
                        }
                    } else if (!skipButton) {
                        JE.state.skipToastShown = false; // Reset when the button is gone
                    }
                }
            }
        });

        skipButtonObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style']
        });
    };

    /**
     * Disconnects the MutationObserver for the skip button.
     */
    JE.stopAutoSkip = () => {
        if (skipButtonObserver) {
            skipButtonObserver.disconnect();
            skipButtonObserver = null;
        }
    };

    // --- Long Press Speed Control ---
    const LONG_PRESS_CONFIG = {
        DURATION: 500,
        SPEED_NORMAL: 1.0,
        SPEED_FAST: 2.0,
        MOVEMENT_THRESHOLD: 10, // pixels - ignore small movements
    };

    let pressTimer = null;
    let isLongPress = false;
    let videoElement = null;
    let originalSpeed = LONG_PRESS_CONFIG.SPEED_NORMAL;
    let speedOverlay = null;
    let pressStartX = null;
    let pressStartY = null;

    function createSpeedOverlay() {
        if (speedOverlay) return;
        speedOverlay = document.createElement('div');
        speedOverlay.setAttribute('data-speed-overlay', 'true');
        speedOverlay.style.cssText = `
            position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
            background: rgba(0,0,0,0.9); color: white; padding: 8px 16px; border-radius: 6px;
            font-size: 1.2em; font-weight: bold; z-index: 999999;
            pointer-events: none; font-family: system-ui;
            opacity: 0; transition: opacity 0.2s ease-out; display: none;
        `;
        document.body.appendChild(speedOverlay);
    }

    function showOverlay(speed) {
        createSpeedOverlay();
        speedOverlay.innerHTML = `${speed}x${speed > 1 ? ' ' + JE.icon(JE.IconName.FAST_FORWARD) : ' ' + JE.icon(JE.IconName.PLAY)}`;
        speedOverlay.style.display = 'block';
        setTimeout(() => speedOverlay.style.opacity = '1', 10);
    }

    function hideOverlay() {
        if (speedOverlay) {
            speedOverlay.style.opacity = '0';
            setTimeout(() => speedOverlay.style.display = 'none', 200);
        }
    }

    JE.handleLongPressDown = (e) => {
        if (!JE.currentSettings.longPress2xEnabled || (e.button !== undefined && e.button !== 0) || pressTimer) {
            return;
        }
        videoElement = getVideo();
        if (!videoElement) return;

        // Store initial press position
        pressStartX = e.clientX || e.touches?.[0]?.clientX;
        pressStartY = e.clientY || e.touches?.[0]?.clientY;

        originalSpeed = videoElement.playbackRate || LONG_PRESS_CONFIG.SPEED_NORMAL;
        isLongPress = false;

        pressTimer = setTimeout(() => {
            if (JE.state.pauseScreenClickTimer) {
                clearTimeout(JE.state.pauseScreenClickTimer);
                JE.state.pauseScreenClickTimer = null;
            }
            isLongPress = true;
            // Make sure video is playing when we activate speed boost
            if (videoElement.paused) {
                videoElement.play().catch(err => console.warn("🪼 Play blocked:", err));
            }
            videoElement.playbackRate = LONG_PRESS_CONFIG.SPEED_FAST;
            showOverlay(LONG_PRESS_CONFIG.SPEED_FAST);
            if (navigator.vibrate) navigator.vibrate(50);
        }, LONG_PRESS_CONFIG.DURATION);
    };

    JE.handleLongPressUp = (e) => {
        if (!pressTimer) return;
        clearTimeout(pressTimer);
        pressTimer = null;

        if (isLongPress) {
            const video = getVideo();
            if (video) {
                video.playbackRate = originalSpeed;
            }
            hideOverlay();
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        }
        isLongPress = false;
        pressStartX = null;
        pressStartY = null;
    };

    JE.handleLongPressCancel = () => {
        if (pressTimer) {
            clearTimeout(pressTimer);
            pressTimer = null;
            if (isLongPress) {
                const video = getVideo();
                if (video) {
                    video.playbackRate = originalSpeed;
                }
                hideOverlay();
            }
            isLongPress = false;
        }
        pressStartX = null;
        pressStartY = null;
    };

    // Handle mouse movement during press to detect drag/scrub
    JE.handleLongPressMove = (e) => {
        if (!pressTimer || isLongPress || !pressStartX || !pressStartY) return;

        const currentX = e.clientX || e.touches?.[0]?.clientX;
        const currentY = e.clientY || e.touches?.[0]?.clientY;

        if (currentX === null || currentY === null) return;

        const distanceMoved = Math.sqrt(
            Math.pow(currentX - pressStartX, 2) + Math.pow(currentY - pressStartY, 2)
        );

        // If user moves more than threshold, cancel the long press (likely a drag attempt)
        if (distanceMoved > LONG_PRESS_CONFIG.MOVEMENT_THRESHOLD) {
            clearTimeout(pressTimer);
            pressTimer = null;
            pressStartX = null;
            pressStartY = null;
        }
    };

    // Block click events that would pause/play when doing a long press
    JE.handleLongPressClick = (e) => {
        // If long press is just completed OR user is still holding (timer active),
        // prevent the click from pausing the video
        if (isLongPress || pressTimer) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return;
        }
    };

})(window.JellyfinEnhanced);